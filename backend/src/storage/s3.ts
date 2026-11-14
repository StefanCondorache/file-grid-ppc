import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { AwsV4Signer } from 'aws4fetch';
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
  rechunk,
  validateKey,
} from './base';
import type { S3Settings } from './config';
import { elapsedMs, errorKind, sleep, throwIfAborted } from './internal';
import type { StorageLogger } from './resilience';

/**
 * S3 adapter (port of P1's `s3.py`; SeaweedFS in FileGrid, any S3 service with path-style URLs).
 *
 * Write: the input is re-sliced into parts of FILEGRID_S3_PART_SIZE (8 MiB). An object smaller
 * than one part is sent with a single PutObject; anything larger uses a multipart upload with one
 * part in flight, so memory stays around two part sizes. S3 makes the object visible only on
 * CompleteMultipartUpload/PutObject success (atomic replace). On any error or abort the multipart
 * upload is aborted, so no orphan parts are left behind.
 *
 * Read: the GetObject body is streamed as the socket delivers it (blocks of at most 64 KiB); the
 * HTTP connection is destroyed when the iterator is closed early. The read timeout covers only the
 * wait for the next block from S3, never the time the consumer holds a block (slow client).
 *
 * Retries: none per request (a dead endpoint must fail fast; the circuit breaker handles it),
 * except multipart parts, which are already in memory: re-sent up to PART_ATTEMPTS times (0.25 s,
 * then 0.5 s pause) on transient errors so a connection reset does not lose a large upload.
 *
 * HTTP: node:http(s) with a keep-alive agent bounded by FILEGRID_S3_MAX_POOL, a TCP connect
 * timeout (FILEGRID_STORAGE_CONNECT_TIMEOUT_S) and a 30 s socket inactivity timeout. Requests are
 * signed with aws4fetch's SigV4 signer using `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
 */

export const PART_ATTEMPTS = 3;
const NOT_FOUND_CODES = new Set(['NoSuchKey', 'NotFound', '404']);
const UNAVAILABLE_CODES = new Set([
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
]);
const MAX_ERROR_BODY = 64 * 1024;
const ABORT_TIMEOUT_MS = 5000;

/** A non-2xx S3 response (or a 200 carrying an <Error> document). */
export class S3ResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`S3 responded ${code || status}`);
    this.name = 'S3ResponseError';
  }
}

class ConnectTimeoutError extends Error {
  override readonly name = 'ConnectTimeoutError';
}

class ReadTimeoutError extends Error {
  override readonly name = 'ReadTimeoutError';
}

function translate(error: unknown, key?: string, source?: HashingStream): unknown {
  if (error instanceof StorageError) return error;
  if (source?.isSourceError(error)) return error;
  if (error instanceof S3ResponseError) {
    const label = error.code || String(error.status);
    if (NOT_FOUND_CODES.has(error.code))
      return new ObjectNotFound(`s3: no object ${JSON.stringify(key)}`);
    if (error.status >= 500 || UNAVAILABLE_CODES.has(error.code)) {
      return new StorageUnavailable(`s3: ${label}`, { cause: error });
    }
    return new StorageError(`s3: ${label}`, { cause: error });
  }
  // Refused/reset connections, timeouts, DNS failures, aborts.
  return new StorageUnavailable(`s3: ${errorKind(error)}`, { cause: error });
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1];
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function readBody(response: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    if (size < limit) parts.push(buffer.subarray(0, limit - size));
    size += buffer.length;
  }
  return Buffer.concat(parts);
}

interface S3Request {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  readonly key?: string;
  readonly search?: string;
  readonly body?: Buffer;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}

interface CompletedPart {
  readonly number: number;
  readonly etag: string;
}

export class S3Storage implements StorageAdapter {
  readonly name: StorageName;
  private readonly agent: http.Agent;
  private readonly transport: typeof http | typeof https;
  private readonly logger?: StorageLogger;

  constructor(
    private readonly settings: S3Settings,
    options: { name?: StorageName; logger?: StorageLogger } = {},
  ) {
    this.name = options.name ?? 's3';
    this.logger = options.logger;
    const secure = settings.endpoint.startsWith('https:');
    this.transport = secure ? https : http;
    const agentOptions = {
      keepAlive: true,
      maxSockets: settings.maxPool,
      maxFreeSockets: settings.maxPool,
    };
    this.agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  }

  private url(key: string | undefined, search: string | undefined): URL {
    const path = key === undefined ? this.settings.bucket : `${this.settings.bucket}/${key}`;
    const url = new URL(`${this.settings.endpoint}/${path}`);
    if (search) url.search = search;
    return url;
  }

  private async send(request: S3Request): Promise<IncomingMessage> {
    throwIfAborted(request.signal);
    const url = this.url(request.key, request.search);
    const signer = new AwsV4Signer({
      method: request.method,
      url: url.toString(),
      headers: request.contentType ? { 'content-type': request.contentType } : {},
      accessKeyId: this.settings.accessKey,
      secretAccessKey: this.settings.secretKey,
      service: 's3',
      region: this.settings.region,
    });
    const signed = await signer.sign();
    const headers: Record<string, string> = Object.fromEntries(signed.headers.entries());
    if (request.body) headers['content-length'] = String(request.body.length);
    else if (request.method === 'PUT' || request.method === 'POST') headers['content-length'] = '0';
    return new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = this.transport.request(url, {
        method: request.method,
        headers,
        agent: this.agent,
        signal: request.signal,
      });
      outgoing.setTimeout(this.settings.readTimeoutMs, () =>
        outgoing.destroy(new ReadTimeoutError('s3: no data from the server in time')),
      );
      outgoing.once('socket', (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(
          () => outgoing.destroy(new ConnectTimeoutError('s3: connect timed out')),
          this.settings.connectTimeoutMs,
        );
        const clear = (): void => clearTimeout(timer);
        socket.once('connect', clear);
        socket.once('close', clear);
      });
      outgoing.once('response', resolve);
      outgoing.once('error', reject);
      outgoing.end(request.body);
    });
  }

  /** Throw `S3ResponseError` for a non-2xx response; otherwise return the (small) body. */
  private async checked(response: IncomingMessage): Promise<Buffer> {
    const status = response.statusCode ?? 0;
    const body = await readBody(response, MAX_ERROR_BODY);
    if (status >= 200 && status < 300) return body;
    const code = xmlValue(body.toString('utf8'), 'Code') ?? String(status);
    throw new S3ResponseError(status, code);
  }

  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    validateKey(key);
    const { signal } = options;
    const hashing = new HashingStream(chunks);
    const partSize = this.settings.partSize;
    let uploadId: string | undefined;
    try {
      const parts: CompletedPart[] = [];
      for await (const block of rechunk(hashing, partSize)) {
        if (uploadId === undefined && block.length < partSize) {
          // rechunk yields a short block only last: the whole object fits in one request
          await this.checked(await this.send({ method: 'PUT', key, body: block, signal }));
          return hashing.result();
        }
        uploadId ??= await this.createMultipart(key, signal);
        const number = parts.length + 1;
        parts.push({ number, etag: await this.uploadPart(key, uploadId, number, block, signal) });
      }
      if (uploadId === undefined) {
        // empty input
        await this.checked(await this.send({ method: 'PUT', key, body: Buffer.alloc(0), signal }));
        return hashing.result();
      }
      await this.completeMultipart(key, uploadId, parts, signal);
      uploadId = undefined;
      return hashing.result();
    } catch (error) {
      await hashing.return();
      if (uploadId !== undefined) await this.abortMultipart(key, uploadId);
      throw translate(error, key, hashing);
    }
  }

  private async createMultipart(key: string, signal: AbortSignal | undefined): Promise<string> {
    const body = await this.checked(
      await this.send({ method: 'POST', key, search: 'uploads', signal }),
    );
    const uploadId = xmlValue(body.toString('utf8'), 'UploadId');
    if (!uploadId) throw new StorageError('s3: CreateMultipartUpload returned no UploadId');
    return uploadId;
  }

  /** Upload one part, retrying transient failures (the part is already in memory). */
  async uploadPart(
    key: string,
    uploadId: string,
    number: number,
    block: Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const search = `partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`;
        const response = await this.send({ method: 'PUT', key, search, body: block, signal });
        const etag = response.headers.etag;
        await this.checked(response);
        if (!etag) throw new StorageError('s3: UploadPart returned no ETag');
        return etag;
      } catch (error) {
        const transient = translate(error, key) instanceof StorageUnavailable;
        if (attempt >= PART_ATTEMPTS || !transient || signal?.aborted) throw error;
        this.logger?.warn(
          { storage: this.name, key, part: number, attempt, error: errorKind(error) },
          's3 part upload failed, retrying',
        );
        await sleep(250 * 2 ** (attempt - 1), signal);
      }
    }
  }

  private async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const response = await this.send({
      method: 'POST',
      key,
      search: `uploadId=${encodeURIComponent(uploadId)}`,
      body: Buffer.from(xml, 'utf8'),
      contentType: 'application/xml',
      signal,
    });
    const status = response.statusCode ?? 0;
    const body = (await this.checked(response)).toString('utf8');
    // S3 may answer 200 and still report a failure in the body.
    if (body.includes('<Error>'))
      throw new S3ResponseError(status, xmlValue(body, 'Code') ?? 'InternalError');
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      // Own timeout: the operation's signal may be aborted already, cleanup must still happen.
      const response = await this.send({
        method: 'DELETE',
        key,
        search: `uploadId=${encodeURIComponent(uploadId)}`,
        signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
      });
      await this.checked(response);
    } catch (error) {
      this.logger?.warn(
        { storage: this.name, key, error: errorKind(error) },
        's3 abort of multipart upload failed',
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
    let response: IncomingMessage;
    try {
      response = await this.send({ method: 'GET', key, signal });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) await this.checked(response);
    } catch (error) {
      throw translate(error, key);
    }
    // The socket inactivity timeout would also fire while the consumer holds a chunk (a slow
    // download client: the paused socket shows no activity). Replace it with a timer that runs only
    // while this read waits for the next chunk from S3.
    response.setTimeout(0);
    const chunks = response[Symbol.asyncIterator]();
    let finished = false;
    try {
      while (true) {
        const step = await this.nextChunk(response, chunks);
        if (step.done) break;
        yield step.value as Buffer;
      }
      finished = true;
    } catch (error) {
      throw translate(error, key);
    } finally {
      if (!finished) response.destroy();
    }
  }

  private async nextChunk(
    response: IncomingMessage,
    chunks: AsyncIterator<unknown>,
  ): Promise<IteratorResult<unknown>> {
    const timer = setTimeout(
      () => response.destroy(new ReadTimeoutError('s3: no data from the server in time')),
      this.settings.readTimeoutMs,
    );
    try {
      return await chunks.next();
    } finally {
      clearTimeout(timer);
    }
  }

  async delete(key: string, options: StorageCallOptions = {}): Promise<void> {
    validateKey(key);
    try {
      await this.checked(await this.send({ method: 'DELETE', key, signal: options.signal }));
    } catch (error) {
      const translated = translate(error, key);
      if (translated instanceof ObjectNotFound) return;
      throw translated;
    }
  }

  async health(options: StorageCallOptions = {}): Promise<HealthStatus> {
    const start = performance.now();
    try {
      await this.checked(await this.send({ method: 'HEAD', signal: options.signal }));
    } catch (error) {
      const translated = translate(error);
      const detail =
        translated instanceof ObjectNotFound
          ? `s3: bucket ${this.settings.bucket} not found`
          : translated instanceof Error
            ? translated.message
            : 's3: health probe failed';
      return { ok: false, latencyMs: elapsedMs(start), detail };
    }
    return {
      ok: true,
      latencyMs: elapsedMs(start),
      detail: `bucket ${this.settings.bucket} reachable`,
    };
  }

  async close(): Promise<void> {
    this.agent.destroy();
  }
}
