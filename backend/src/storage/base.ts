import { createHash } from 'node:crypto';

/**
 * Storage adapter contract shared by every FileGrid storage (S3, FTP, DB). TypeScript port of
 * P1's `backend/app/storage/base.py`: same semantics, same key rules, same errors.
 *
 * `await adapter.putStream(key, chunks)` consumes an `AsyncIterable<Uint8Array>` and stores it
 * under `key`. Memory use is constant: each adapter keeps at most one bounded buffer (S3 part, DB
 * row) and never the whole object. SHA-256 and size are computed while streaming. The write is
 * atomic and durable: when the promise resolves the object is complete and visible; if it rejects,
 * nothing partial is visible under `key` (an older object under the same key stays intact).
 * Writing an existing key replaces it. Chunks must not be mutated after they were yielded.
 *
 * `adapter.getStream(key)` is a plain method returning an async iterable over the stored bytes in
 * bounded chunks. It throws `ObjectNotFound` on the first iteration when the key does not exist.
 * Stopping early (`break` in `for await`, `return()`) releases the connection. JavaScript never
 * finalizes an abandoned generator, so always consume it with `for await` or call `return()`.
 *
 * `await adapter.delete(key)` is idempotent: deleting a missing key is not an error.
 * `await adapter.health()` never throws for storage problems; it resolves `{ ok: false, ... }`.
 * `await adapter.close()` releases pooled connections; safe to call more than once.
 *
 * Every method accepts an optional `{ signal }`: aborting it makes the adapter give up the
 * operation and release its connection (`ResilientStorage` uses it for its timeouts).
 *
 * Errors (all `StorageError`): `StorageUnavailable` (down, timed out, circuit open: retry later or
 * use the policy's fallback storage), `ObjectNotFound`, `IntegrityError` (hash mismatch: the file
 * is corrupted), `InvalidKey`. Messages never contain credentials.
 *
 * Keys (`validateKey`): 1..512 chars, `/`-separated segments, each `[A-Za-z0-9_][A-Za-z0-9._-]*`
 * (no leading `/`, no `//`, no trailing `/`, no `.`/`..`, no hidden `.name`, no leading `-`).
 * Example: `fault_records/2026/11/14/3f2a9c.bin`.
 *
 * Download integrity: wrap the stream so the hash is recomputed while the client receives it:
 *
 *     for await (const chunk of verifyStream(storage.getStream(key), file.sha256)) { ... }
 *
 * `IntegrityError` is thrown after the last chunk on mismatch, so the HTTP layer must abort the
 * response (not end it cleanly) and mark the file as corrupted. The hash covers the bytes as
 * stored (ciphertext for encrypted categories).
 */

export const STORAGE_NAMES = ['s3', 'ftp', 'db'] as const;
export type StorageName = (typeof STORAGE_NAMES)[number];

export function isStorageName(value: unknown): value is StorageName {
  return typeof value === 'string' && (STORAGE_NAMES as readonly string[]).includes(value);
}

export const MAX_KEY_LENGTH = 512;
const SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export interface PutResult {
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
}

export interface HealthStatus {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
}

export interface StorageCallOptions {
  readonly signal?: AbortSignal;
}

export interface StorageAdapter {
  readonly name: StorageName;
  putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options?: StorageCallOptions,
  ): Promise<PutResult>;
  getStream(key: string, options?: StorageCallOptions): AsyncIterable<Buffer>;
  delete(key: string, options?: StorageCallOptions): Promise<void>;
  health(options?: StorageCallOptions): Promise<HealthStatus>;
  close(): Promise<void>;
}

/** Base class for every storage-layer error. */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The storage cannot serve the request now (down, timed out, or its circuit breaker is open). */
export class StorageUnavailable extends StorageError {}

/** No object is stored under the requested key. */
export class ObjectNotFound extends StorageError {}

/** The bytes read back do not match the expected SHA-256 (corruption). */
export class IntegrityError extends StorageError {}

/** The key is not a safe storage key (see `validateKey`). */
export class InvalidKey extends StorageError {}

function describeSegment(segment: string): string {
  const shown = segment.length > 64 ? `${segment.slice(0, 64)}...` : segment;
  return JSON.stringify(shown);
}

/** Return `key` unchanged if it is a safe storage key, else throw `InvalidKey`. */
export function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidKey('key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidKey(`key longer than ${MAX_KEY_LENGTH} characters`);
  }
  for (const segment of key.split('/')) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new InvalidKey(`unsafe key segment ${describeSegment(segment)}`);
    }
  }
  return key;
}

/** View a chunk as a Buffer without copying it. */
export function toBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
}

/** Close an async iterator if it supports `return()`; errors from closing are ignored. */
export async function closeQuietly(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
  try {
    await iterator?.return?.();
  } catch {
    // closing must never mask the original outcome
  }
}

/**
 * Async iterable that passes chunks through while computing size and SHA-256.
 * The values are final once the iterator is exhausted; closing it closes the source.
 * `failed`/`failure` record an error thrown by the source, so adapters can tell the caller's
 * input failing apart from their own I/O errors.
 */
export class HashingStream implements AsyncIterableIterator<Buffer> {
  size = 0;
  failed = false;
  failure: unknown = undefined;
  private readonly hash = createHash('sha256');
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<Buffer, undefined>> {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await this.iterator.next();
    } catch (error) {
      this.failed = true;
      this.failure = error;
      throw error;
    }
    if (step.done) return { done: true, value: undefined };
    const chunk = toBuffer(step.value);
    if (chunk.length > 0) {
      this.hash.update(chunk);
      this.size += chunk.length;
    }
    return { done: false, value: chunk };
  }

  async return(): Promise<IteratorResult<Buffer, undefined>> {
    await closeQuietly(this.iterator);
    return { done: true, value: undefined };
  }

  /** True if `error` is the error the source threw. */
  isSourceError(error: unknown): boolean {
    return this.failed && this.failure === error;
  }

  get sha256(): string {
    return this.hash.copy().digest('hex');
  }

  result(): PutResult {
    return { size: this.size, sha256: this.sha256 };
  }
}

/**
 * Re-slice an async byte stream into blocks of exactly `size` bytes (the last one may be shorter;
 * empty input yields nothing). Memory stays below `size` + one input chunk; every byte is copied
 * once. Takes ownership of `source` (closed when this generator finishes or is closed early).
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer, void, undefined> {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer');
  let parts: Buffer[] = [];
  let pending = 0;
  for await (const raw of source) {
    let chunk = toBuffer(raw);
    while (pending + chunk.length >= size) {
      const take = size - pending;
      parts.push(chunk.subarray(0, take));
      const block = Buffer.concat(parts, size);
      parts = [];
      pending = 0;
      chunk = chunk.subarray(take);
      yield block;
    }
    if (chunk.length > 0) {
      parts.push(chunk);
      pending += chunk.length;
    }
  }
  if (pending > 0) yield Buffer.concat(parts, pending);
}

/**
 * Yield `stream` unchanged while re-hashing it; throw `IntegrityError` at the end on mismatch.
 * Takes ownership of `stream`: it is closed when this generator finishes or is closed early.
 */
export async function* verifyStream(
  stream: AsyncIterable<Uint8Array>,
  expectedSha256: string,
): AsyncGenerator<Buffer, void, undefined> {
  const expected = expectedSha256.toLowerCase();
  const hashing = new HashingStream(stream);
  for await (const chunk of hashing) yield chunk;
  const actual = hashing.sha256;
  if (actual !== expected) {
    throw new IntegrityError(
      `sha256 mismatch: expected ${expected}, got ${actual} (${hashing.size} bytes read)`,
    );
  }
}
