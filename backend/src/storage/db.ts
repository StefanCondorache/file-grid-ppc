import { performance } from 'node:perf_hooks';
import {
  Client,
  type ClientBase,
  type ClientConfig,
  DatabaseError,
  Pool,
  type PoolClient,
} from 'pg';
import {
  type HealthStatus,
  HashingStream,
  IntegrityError,
  ObjectNotFound,
  type PutResult,
  type StorageAdapter,
  type StorageCallOptions,
  StorageBusy,
  StorageError,
  type StorageName,
  StorageUnavailable,
  rechunk,
  validateKey,
} from './base';
import type { DbSettings } from './config';
import { Mutex, abortable, elapsedMs, errorKind, onAbort, throwIfAborted } from './internal';
import type { StorageLogger } from './resilience';

/**
 * PostgreSQL adapter (port of P1's `db.py`): objects stored as ordered `bytea` rows in schema
 * `blobstore`, same DDL so both implementations can share a database.
 *
 *   blobstore.objects(key text PRIMARY KEY, size bigint, sha256 text, created_at timestamptz)
 *   blobstore.chunks(key REFERENCES objects ON DELETE CASCADE, seq int, data bytea STORAGE EXTERNAL)
 *
 * Write: one transaction per object. It takes a per-key advisory lock (concurrent writers of the
 * same key serialize), deletes the previous version, inserts the object row and the input
 * re-sliced into rows of FILEGRID_PG_CHUNK_SIZE as it arrives, records size and SHA-256 and
 * commits. Readers see the previous version until COMMIT (atomic replace). Memory: one row.
 * The transaction and a pooled connection stay open while the caller streams.
 *
 * Read: a REPEATABLE READ, read-only transaction fetching rows two at a time in seq order (keyset
 * batches). The total length is checked against `objects.size` (a missing row raises
 * IntegrityError). Stopping early rolls back and returns the connection to the pool.
 */

export const SCHEMA = 'blobstore';
const SCHEMA_LOCK_ID = 0x46470001; // advisory lock id for ensureSchema ("FG" 0001)
const KEY_LOCK_CLASS = 0x4647; // first half of the two-int advisory lock taken per key
// pg-pool's error when every pooled client stayed checked out for connectionTimeoutMillis: overload
// (slow transfers hold the connections), not an outage. A failed *connect* has another message.
const POOL_EXHAUSTED = /timeout exceeded when trying to connect/;
const IDLE_CONNECTION_MS = 60_000;
const READ_BATCH = 2;
const CLOSE_TIMEOUT_MS = 5000;

const DDL = `
CREATE SCHEMA IF NOT EXISTS blobstore;
CREATE TABLE IF NOT EXISTS blobstore.objects (
    key        text PRIMARY KEY,
    size       bigint NOT NULL,
    sha256     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blobstore.chunks (
    key  text NOT NULL REFERENCES blobstore.objects (key) ON DELETE CASCADE,
    seq  integer NOT NULL,
    data bytea NOT NULL,
    PRIMARY KEY (key, seq)
);
`;

const INSERT_CHUNK = 'INSERT INTO blobstore.chunks (key, seq, data) VALUES ($1, $2, $3)';
const READ_CHUNKS =
  'SELECT seq, data FROM blobstore.chunks WHERE key = $1 AND seq >= $2 ORDER BY seq LIMIT $3';

// SQLSTATE classes that mean "the database cannot serve us now": connection exceptions,
// insufficient resources (incl. too many connections), admin/crash shutdown, cannot connect now.
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0[123])/;

function translate(error: unknown, source?: HashingStream): unknown {
  if (error instanceof StorageError) return error;
  if (source?.isSourceError(error)) return error;
  if (error instanceof DatabaseError) {
    const code = error.code ?? 'unknown';
    if (UNAVAILABLE_SQLSTATE.test(code)) {
      return new StorageUnavailable(`db: SQLSTATE ${code}`, { cause: error });
    }
    return new StorageError(`db: SQLSTATE ${code}`, { cause: error });
  }
  // Refused/reset/terminated connections and connect timeouts.
  return new StorageUnavailable(`db: ${errorKind(error)}`, { cause: error });
}

function destroyConnection(client: ClientBase | undefined): void {
  (client as Client | undefined)?.connection?.stream?.destroy();
}

async function acquire(pool: Pool, signal: AbortSignal | undefined): Promise<PoolClient> {
  throwIfAborted(signal);
  const pending = pool.connect();
  try {
    return await abortable(pending, signal);
  } catch (error) {
    pending.then(
      (client) => client.release(),
      () => undefined,
    );
    if (error instanceof Error && POOL_EXHAUSTED.test(error.message)) {
      throw new StorageBusy('db: every pooled connection is in use', { cause: error });
    }
    throw error;
  }
}

export class DbStorage implements StorageAdapter {
  readonly name: StorageName;
  private pool: Pool | null = null;
  private schemaReady = false;
  private readonly initLock = new Mutex();
  private readonly logger?: StorageLogger;

  constructor(
    private readonly settings: DbSettings,
    options: { name?: StorageName; logger?: StorageLogger } = {},
  ) {
    this.name = options.name ?? 'db';
    this.logger = options.logger;
  }

  private createPool(): Pool {
    const connectTimeoutMs = this.settings.connectTimeoutMs;
    // pg-pool uses one timeout for "wait for a free client" and "connect a new one"; this client
    // class applies the shorter connect timeout to the TCP connect + login itself.
    class TimedClient extends Client {
      constructor(config?: ClientConfig) {
        super({ ...config, connectionTimeoutMillis: connectTimeoutMs });
      }
    }
    const pool = new Pool({
      connectionString: this.settings.dsn,
      max: this.settings.poolMax,
      // Waiting for a free pooled connection (all busy) is overload, not an outage: allow longer.
      connectionTimeoutMillis: this.settings.acquireTimeoutMs,
      idleTimeoutMillis: IDLE_CONNECTION_MS,
      Client: TimedClient as unknown as new () => ClientBase,
    });
    // pg emits 'error' on a client whose connection ends unexpectedly (DB restart, terminated backend,
    // a destroyed connection after an abort). pg-pool listens only while a client is idle, so give
    // every client its own listener for its whole life; otherwise a checked-out client crashes the
    // process. The failing query still rejects, so the operation fails as StorageUnavailable.
    pool.on('connect', (client) =>
      client.on('error', (error) =>
        this.logger?.warn(
          { storage: this.name, error: errorKind(error) },
          'db connection failed while in use',
        ),
      ),
    );
    // An idle client can die (DB restart); without a listener that would crash the process.
    pool.on('error', (error) =>
      this.logger?.warn(
        { storage: this.name, error: errorKind(error) },
        'idle db connection failed',
      ),
    );
    return pool;
  }

  private async getPool(): Promise<Pool> {
    if (this.pool && this.schemaReady) return this.pool;
    return this.initLock.run(async () => {
      this.pool ??= this.createPool();
      if (!this.schemaReady) await this.createSchema(this.pool);
      return this.pool;
    });
  }

  /** Create the `blobstore` schema if needed (also done lazily on first use). */
  async ensureSchema(): Promise<void> {
    try {
      await this.getPool();
    } catch (error) {
      throw translate(error);
    }
  }

  private async createSchema(pool: Pool): Promise<void> {
    const client = await pool.connect();
    let healthy = true;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
      await client.query(DDL);
      const storage = await client.query<{ attstorage: string }>(
        "SELECT attstorage FROM pg_attribute WHERE attrelid = 'blobstore.chunks'::regclass AND attname = 'data'",
      );
      if (storage.rows[0]?.attstorage !== 'e') {
        await client.query('ALTER TABLE blobstore.chunks ALTER COLUMN data SET STORAGE EXTERNAL');
      }
      await client.query('COMMIT');
      this.schemaReady = true;
    } catch (error) {
      healthy = await rollbackQuietly(client);
      throw error;
    } finally {
      client.release(healthy ? undefined : true);
    }
  }

  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    validateKey(key);
    const { signal } = options;
    const hashing = new HashingStream(chunks);
    let client: PoolClient | undefined;
    let healthy = true;
    let unlink = (): void => undefined;
    try {
      const pool = await this.getPool();
      const acquired = await acquire(pool, signal);
      client = acquired;
      unlink = onAbort(signal, () => {
        healthy = false;
        destroyConnection(acquired);
      });
      await acquired.query('BEGIN');
      await acquired.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [KEY_LOCK_CLASS, key]);
      await acquired.query('DELETE FROM blobstore.objects WHERE key = $1', [key]);
      await acquired.query("INSERT INTO blobstore.objects (key, size, sha256) VALUES ($1, 0, '')", [
        key,
      ]);
      let seq = 0;
      for await (const block of rechunk(hashing, this.settings.chunkSize)) {
        await acquired.query({
          name: 'filegrid-blobstore-insert-chunk',
          text: INSERT_CHUNK,
          values: [key, seq, block],
        });
        seq += 1;
      }
      await acquired.query(
        'UPDATE blobstore.objects SET size = $2, sha256 = $3, created_at = now() WHERE key = $1',
        [key, hashing.size, hashing.sha256],
      );
      await acquired.query('COMMIT');
      return hashing.result();
    } catch (error) {
      await hashing.return();
      const translated = translate(error, hashing);
      if (client && healthy) {
        healthy = !(translated instanceof StorageUnavailable) && (await rollbackQuietly(client));
      }
      throw translated;
    } finally {
      unlink();
      client?.release(healthy ? undefined : true);
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
    let client: PoolClient | undefined;
    let healthy = true;
    let committed = false;
    let unlink = (): void => undefined;
    try {
      const pool = await this.getPool();
      const acquired = await acquire(pool, signal);
      client = acquired;
      unlink = onAbort(signal, () => {
        healthy = false;
        destroyConnection(acquired);
      });
      await acquired.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const head = await acquired.query<{ size: string }>(
        'SELECT size FROM blobstore.objects WHERE key = $1',
        [key],
      );
      if (head.rows.length === 0) throw new ObjectNotFound(`db: no object ${JSON.stringify(key)}`);
      const expected = Number(head.rows[0].size);
      let total = 0;
      let nextSeq = 0;
      while (true) {
        const batch = await acquired.query<{ seq: number; data: Buffer }>({
          name: 'filegrid-blobstore-read-chunks',
          text: READ_CHUNKS,
          values: [key, nextSeq, READ_BATCH],
        });
        for (const row of batch.rows) {
          total += row.data.length;
          nextSeq = row.seq + 1;
          yield row.data;
        }
        if (batch.rows.length < READ_BATCH) break;
      }
      if (total !== expected) {
        throw new IntegrityError(
          `db: object ${JSON.stringify(key)} has ${total} bytes, expected ${expected}`,
        );
      }
      await acquired.query('COMMIT');
      committed = true;
    } catch (error) {
      const translated = translate(error);
      if (translated instanceof StorageUnavailable) healthy = false;
      throw translated;
    } finally {
      unlink();
      if (client) {
        if (!committed && healthy) healthy = await rollbackQuietly(client);
        client.release(healthy ? undefined : true);
      }
    }
  }

  async delete(key: string, options: StorageCallOptions = {}): Promise<void> {
    validateKey(key);
    let client: PoolClient | undefined;
    let healthy = true;
    let unlink = (): void => undefined;
    try {
      const pool = await this.getPool();
      const acquired = await acquire(pool, options.signal);
      client = acquired;
      unlink = onAbort(options.signal, () => {
        healthy = false;
        destroyConnection(acquired);
      });
      await acquired.query('DELETE FROM blobstore.objects WHERE key = $1', [key]);
    } catch (error) {
      const translated = translate(error);
      if (translated instanceof StorageUnavailable) healthy = false;
      throw translated;
    } finally {
      unlink();
      client?.release(healthy ? undefined : true);
    }
  }

  async health(options: StorageCallOptions = {}): Promise<HealthStatus> {
    // A dedicated short-lived connection: a pool saturated by long uploads must not look "down".
    const start = performance.now();
    const client = new Client({
      connectionString: this.settings.dsn,
      connectionTimeoutMillis: this.settings.connectTimeoutMs,
    });
    client.on('error', () => undefined);
    const unlink = onAbort(options.signal, () => destroyConnection(client));
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { ok: true, latencyMs: elapsedMs(start), detail: 'SELECT 1 ok' };
    } catch (error) {
      const translated = translate(error);
      const detail = translated instanceof Error ? translated.message : 'db: health probe failed';
      return { ok: false, latencyMs: elapsedMs(start), detail };
    } finally {
      unlink();
      client.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.schemaReady = false;
    if (!pool) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      timer.unref();
    });
    try {
      await Promise.race([pool.end(), timeout]);
    } catch (error) {
      this.logger?.warn({ storage: this.name, error: errorKind(error) }, 'db pool close failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** ROLLBACK; true if the connection is still usable afterwards. */
async function rollbackQuietly(client: ClientBase): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}
