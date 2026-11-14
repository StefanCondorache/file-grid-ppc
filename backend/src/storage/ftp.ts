import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import { Client, FTPError } from 'basic-ftp';
import {
  type HealthStatus,
  HashingStream,
  ObjectNotFound,
  type PutResult,
  type StorageAdapter,
  type StorageCallOptions,
  StorageError,
  type StorageName,
  StorageUnavailable,
  validateKey,
} from './base';
import type { FtpSettings } from './config';
import { Semaphore, abortable, elapsedMs, errorKind, onAbort, sleep } from './internal';
import type { StorageLogger } from './resilience';

/**
 * FTP adapter (port of P1's `ftp.py`; pure-ftpd in FileGrid), passive mode (EPSV, then PASV).
 *
 * Write: the object is streamed to a hidden temporary name in the target directory
 * (`dir/.name.<random>.part`) and renamed onto the final key only after the server confirmed the
 * transfer (226). A reader never sees a partial file; on any error the temporary file is removed
 * on a fresh connection (best effort). Parent directories are created on demand (MKD, "already
 * exists" ignored) and remembered per process.
 *
 * Read: RETR on a passive data connection, piped through a bounded buffer (256 KiB). Closing the
 * iterator early closes the data connection; the control connection goes back to the pool only if
 * a NOOP proves it is still in sync (`resyncAfterAbort`), otherwise it is closed.
 *
 * Connections: a small pool of logged-in control connections bounded by
 * FILEGRID_FTP_MAX_CONNECTIONS (pure-ftpd's per-IP and total session limits). Logging in is slow
 * on pure-ftpd (1-4 s), so idle connections are kept for up to 120 s and reused, but only after an
 * operation that finished cleanly. `health()` keeps one dedicated logged-in connection outside the
 * pool and sends NOOP on it; a login that outlasts a probe keeps running in the background, so the
 * next probe only sends NOOP instead of starting another login. While it runs, `healthPending()`
 * is true, so the resilience layer does not count those timed-out probes as failures.
 */

export const READ_BUFFER = 256 * 1024;
export const IDLE_TTL_MS = 120_000;
export const RESYNC_TIMEOUT_MS = 2000;
const MAX_KNOWN_DIRS = 4096;
const CLEANUP_TIMEOUT_MS = 5000;
const UNAVAILABLE_CODES = new Set([421, 425, 426, 450, 451, 452]);
// 550 from pure-ftpd; some servers (ftp-srv) answer a missing file with 551.
const NOT_FOUND = new Set([550, 551]);

class ConnectTimeoutError extends Error {
  override readonly name = 'ConnectTimeoutError';
}

function translate(error: unknown, source?: HashingStream): unknown {
  if (error instanceof StorageError) return error;
  if (source?.isSourceError(error)) return error;
  // basic-ftp reports socket errors (ECONNREFUSED...) as FTPError with a string code: those are
  // connection problems, not FTP status replies.
  if (error instanceof FTPError && typeof error.code === 'number') {
    const message = `ftp: status ${error.code}`;
    return UNAVAILABLE_CODES.has(error.code)
      ? new StorageUnavailable(message, { cause: error })
      : new StorageError(message, { cause: error });
  }
  // Refused/reset connections, timeouts, "client is closed".
  return new StorageUnavailable(`ftp: ${errorKind(error)}`, { cause: error });
}

function isNotFound(error: unknown): boolean {
  return error instanceof FTPError && typeof error.code === 'number' && NOT_FOUND.has(error.code);
}

function splitKey(key: string): { dir: string; base: string } {
  const slash = key.lastIndexOf('/');
  return slash < 0
    ? { dir: '', base: key }
    : { dir: key.slice(0, slash), base: key.slice(slash + 1) };
}

/**
 * After the data connection was closed mid-transfer: true if the control channel is provably in
 * sync. pure-ftpd may or may not send a final reply (226/426/451) for the aborted transfer. NOOP is
 * answered with 200, a code no transfer reply uses, so: send NOOP and read replies until the 200,
 * skipping at most two stale transfer replies. Anything else (or no 200 in time) => not in sync.
 */
export function resyncAfterAbort(
  client: Pick<Client, 'ftp'>,
  timeoutMs = RESYNC_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    let stale = 0;
    client.ftp
      .handle('NOOP', (response, task) => {
        if (response instanceof Error && !(response instanceof FTPError)) {
          task.reject(response);
          return;
        }
        if (response.code === 200) {
          task.resolve(true);
          return;
        }
        stale += 1; // a late reply of the aborted transfer
        if (stale >= 3) task.resolve(false);
      })
      .then(
        (inSync: unknown) => {
          clearTimeout(timer);
          resolve(inSync === true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
  });
}

export type FtpConnect = () => Promise<Client>;

class FtpPool {
  private readonly permits: Semaphore;
  private idle: Array<{ since: number; client: Client }> = [];
  private closed = false;

  constructor(
    private readonly settings: FtpSettings,
    readonly connect: FtpConnect,
  ) {
    this.permits = new Semaphore(settings.maxConnections);
  }

  async lease(signal: AbortSignal | undefined): Promise<Client> {
    await this.permits.acquire(signal);
    try {
      const now = performance.now();
      while (this.idle.length > 0) {
        const candidate = this.idle.pop() as { since: number; client: Client };
        if (now - candidate.since < IDLE_TTL_MS && !candidate.client.closed)
          return candidate.client;
        candidate.client.close();
      }
      return await abortable(this.connect(), signal);
    } catch (error) {
      this.permits.release();
      throw error;
    }
  }

  /** Return a leased client: kept for reuse only if the caller proved the channel is in sync. */
  release(client: Client, reusable: boolean): void {
    if (reusable && !this.closed && !client.closed) {
      this.idle.push({ since: performance.now(), client });
    } else {
      client.close();
    }
    this.permits.release();
  }

  /** A pooled connection for `fn`; reused only after a clean exit. Abort closes it. */
  async use<T>(signal: AbortSignal | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.lease(signal);
    let reusable = false;
    const unlink = onAbort(signal, () => client.close());
    try {
      const result = await fn(client);
      reusable = !signal?.aborted;
      return result;
    } finally {
      unlink();
      this.release(client, reusable);
    }
  }

  close(): void {
    this.closed = true;
    const idle = this.idle;
    this.idle = [];
    for (const { client } of idle) client.close();
  }
}

export interface FtpStorageOptions {
  name?: StorageName;
  logger?: StorageLogger;
  /** Replaces the connect + login step (tests). */
  connect?: FtpConnect;
}

export class FtpStorage implements StorageAdapter {
  readonly name: StorageName;
  private readonly pool: FtpPool;
  private readonly knownDirs = new Set<string>();
  private readonly logger?: StorageLogger;
  private healthClient: Client | undefined;
  private healthLogin: Promise<{ client: Client; loginMs: number }> | undefined;
  private healthLoginRunning = false;
  private noop: Promise<void> | undefined;

  constructor(
    private readonly settings: FtpSettings,
    options: FtpStorageOptions = {},
  ) {
    this.name = options.name ?? 'ftp';
    this.logger = options.logger;
    this.pool = new FtpPool(settings, options.connect ?? (() => this.connect()));
  }

  /** Open a control connection and log in. Only the TCP connect + greeting has the short timeout. */
  private async connect(): Promise<Client> {
    const s = this.settings;
    const client = new Client(s.socketTimeoutMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ConnectTimeoutError('ftp: connect timed out'));
          client.close();
        }, s.connectTimeoutMs);
        client.connect(s.host, s.port).then(() => resolve(), reject);
      });
      clearTimeout(timer);
      await client.login(s.user, s.password);
      await client.useDefaultSettings();
      return client;
    } catch (error) {
      clearTimeout(timer);
      client.close();
      throw error;
    }
  }

  private async ensureDir(client: Client, directory: string): Promise<void> {
    if (directory === '' || this.knownDirs.has(directory)) return;
    let current = '';
    for (const part of directory.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (this.knownDirs.has(current)) continue;
      try {
        await client.send(`MKD ${current}`);
      } catch (error) {
        // 550 = already exists (or not permitted: STOR will tell)
        if (!isNotFound(error)) throw error;
      }
      if (this.knownDirs.size > MAX_KNOWN_DIRS) this.knownDirs.clear();
      this.knownDirs.add(current);
    }
  }

  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    validateKey(key);
    const { dir, base } = splitKey(key);
    const tmp = `${dir ? `${dir}/` : ''}.${base}.${randomBytes(8).toString('hex')}.part`;
    const hashing = new HashingStream(chunks);
    let stored = false; // true once STOR may have created the temporary file
    try {
      await this.pool.use(options.signal, async (client) => {
        await this.ensureDir(client, dir);
        stored = true;
        // uploadFrom resolves only after "226 transfer complete": tmp is fully written
        await client.uploadFrom(Readable.from(hashing, { objectMode: false }), tmp);
        await client.rename(tmp, key); // pure-ftpd RNFR/RNTO = rename(2): atomic replace
      });
      return hashing.result();
    } catch (error) {
      this.knownDirs.clear();
      await hashing.return();
      // never pay a second connect timeout when the server was not even reachable
      if (stored) await this.removeQuietly(tmp);
      throw translate(error, hashing);
    }
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      await this.pool.use(AbortSignal.timeout(CLEANUP_TIMEOUT_MS), async (client) => {
        try {
          await client.remove(path);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      });
    } catch (error) {
      this.logger?.warn(
        { storage: this.name, path, error: errorKind(error) },
        'ftp could not remove temporary file',
      );
    }
  }

  getStream(
    key: string,
    options: StorageCallOptions = {},
  ): AsyncGenerator<Buffer, void, undefined> {
    validateKey(key);
    return this.read(key, options.signal);
  }

  private async *read(
    key: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Buffer, void, undefined> {
    let client: Client | undefined;
    let reusable = false;
    let settled = false;
    let destination: PassThrough | undefined;
    let outcome: Promise<unknown> = Promise.resolve(undefined);
    let unlink = (): void => undefined;
    try {
      const leased = await this.pool.lease(signal);
      client = leased;
      unlink = onAbort(signal, () => leased.close());
      const sink = new PassThrough({ highWaterMark: READ_BUFFER });
      destination = sink;
      // Resolves with the transfer's error (or undefined): never rejects.
      outcome = leased.downloadTo(sink, key).then(
        () => undefined,
        (error: unknown) => error ?? new Error('download failed'),
      );
      try {
        for await (const chunk of sink) yield chunk as Buffer;
      } catch (streamError) {
        throw (await outcome) ?? streamError;
      }
      const failure = await outcome; // waits for 226: the server sent the whole file
      settled = true;
      if (failure !== undefined) throw failure;
      reusable = !signal?.aborted;
    } catch (error) {
      settled = true;
      if (isNotFound(error)) {
        reusable = !signal?.aborted; // a clean 550 reply: the channel is in sync
        throw new ObjectNotFound(`ftp: no object ${JSON.stringify(key)}`);
      }
      throw translate(error);
    } finally {
      unlink();
      if (client) {
        if (!settled) {
          // The consumer stopped early (cancelled download, partial read). Logging in again costs
          // seconds on pure-ftpd, so keep the connection if the channel is provably in sync.
          // Close the data connection too (as P1's adapter does): otherwise the server keeps writing
          // into a socket nobody reads and never sends the transfer's final reply.
          destination?.destroy();
          client.ftp.dataSocket?.destroy();
          const timer = new AbortController();
          const finished = await Promise.race([
            outcome.then(() => true),
            sleep(RESYNC_TIMEOUT_MS, timer.signal).then(
              () => false,
              () => false,
            ),
          ]);
          timer.abort();
          reusable = finished && !client.closed && (await resyncAfterAbort(client));
        }
        this.pool.release(client, reusable);
      }
    }
  }

  async delete(key: string, options: StorageCallOptions = {}): Promise<void> {
    validateKey(key);
    try {
      await this.pool.use(options.signal, async (client) => {
        try {
          await client.remove(key);
        } catch (error) {
          if (!isNotFound(error)) throw error; // missing file: idempotent delete
        }
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async health(options: StorageCallOptions = {}): Promise<HealthStatus> {
    const { signal } = options;
    let start = performance.now();
    const client = this.healthClient;
    if (client && !client.closed) {
      const noop = (this.noop ??= client.send('NOOP').then(
        () => undefined,
        (error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      ));
      void noop.then(
        () => undefined,
        () => undefined,
      );
      try {
        await abortable(noop, signal);
        return { ok: true, latencyMs: elapsedMs(start), detail: 'NOOP ok' };
      } catch (error) {
        // broken (server restarted?) or the probe timed out with the state unknown: drop it
        this.dropHealthClient(client);
        if (signal?.aborted) throw error;
        start = performance.now();
      } finally {
        if (this.noop === noop) this.noop = undefined;
      }
    } else if (client) {
      this.dropHealthClient(client);
    }
    // The login runs on its own, unaffected by the probe's timeout: when a login takes longer than
    // one probe it still completes, and the next probe only sends NOOP.
    this.healthLogin ??= this.loginForHealth();
    const login = this.healthLogin;
    let result: { client: Client; loginMs: number };
    try {
      result = await abortable(login, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.healthLogin === login) this.healthLogin = undefined;
      const translated = translate(error);
      const detail = translated instanceof Error ? translated.message : 'ftp: login failed';
      return { ok: false, latencyMs: elapsedMs(start), detail };
    }
    if (this.healthLogin === login) {
      this.healthLogin = undefined;
      this.healthClient = result.client;
    }
    // latency = how long the login took, even if an earlier probe had already given up on it
    return { ok: true, latencyMs: result.loginMs, detail: 'login + NOOP ok' };
  }

  /** True while the shared health login is still running (see `HealthStatus.pending`). */
  healthPending(): boolean {
    return this.healthLoginRunning;
  }

  private loginForHealth(): Promise<{ client: Client; loginMs: number }> {
    const start = performance.now();
    this.healthLoginRunning = true;
    const login = (async () => {
      const client = await this.pool.connect();
      try {
        await client.send('NOOP');
      } catch (error) {
        client.close();
        throw error;
      }
      return { client, loginMs: elapsedMs(start) };
    })();
    // A login nobody waits for any more must not become an unhandled rejection.
    login.then(
      () => {
        this.healthLoginRunning = false;
      },
      () => {
        this.healthLoginRunning = false;
      },
    );
    return login;
  }

  private dropHealthClient(client: Client): void {
    if (this.healthClient === client) this.healthClient = undefined;
    client.close();
  }

  async close(): Promise<void> {
    const login = this.healthLogin;
    this.healthLogin = undefined;
    if (login) {
      login.then(
        ({ client }) => client.close(),
        () => undefined,
      );
    }
    if (this.healthClient) this.dropHealthClient(this.healthClient);
    this.pool.close();
  }
}
