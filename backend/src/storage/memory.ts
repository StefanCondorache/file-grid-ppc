import { createHash } from 'node:crypto';
import {
  type HealthStatus,
  HashingStream,
  ObjectNotFound,
  type PutResult,
  type StorageAdapter,
  type StorageCallOptions,
  type StorageName,
  StorageUnavailable,
  validateKey,
} from './base';
import { sleep, throwIfAborted } from './internal';

const DEFAULT_READ_BLOCK = 64 * 1024;

interface StoredObject {
  readonly data: Buffer;
  readonly sha256: string;
}

export interface MemoryStorageOptions {
  /** Size of the chunks `getStream` yields. */
  readonly readBlock?: number;
}

/**
 * In-process storage with the same contract as the real adapters (atomic replace, nothing partial
 * visible after a failed put, `ObjectNotFound` on first iteration, idempotent delete). Used by the
 * tests and by `FILEGRID_STORAGE_DRIVER=memory`; it keeps whole objects in memory, so it is not
 * meant for large files.
 *
 * Test hooks: `setAvailable(false)` simulates an outage (every operation, including a transfer in
 * progress, fails with `StorageUnavailable` and `health()` reports down); `setDelayMs(ms)` makes the
 * storage wait before each chunk it reads or writes (abortable), to exercise timeouts.
 */
export class MemoryStorage implements StorageAdapter {
  readonly name: StorageName;
  private readonly objects = new Map<string, StoredObject>();
  private readonly readBlock: number;
  private available = true;
  private delayMs = 0;
  calls = 0;
  /** Reads started and not yet finished or closed (test hook: proves a reader was released). */
  openReads = 0;

  constructor(name: StorageName, options: MemoryStorageOptions = {}) {
    this.name = name;
    this.readBlock = options.readBlock ?? DEFAULT_READ_BLOCK;
  }

  setAvailable(up: boolean): void {
    this.available = up;
  }

  setDelayMs(ms: number): void {
    this.delayMs = ms;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Raw stored bytes (test hook). */
  read(key: string): Buffer {
    const object = this.objects.get(key);
    if (!object) throw new ObjectNotFound(`${this.name}: no object ${key}`);
    return object.data;
  }

  /** Drops every object and makes the storage healthy again (test hook). */
  clear(): void {
    this.objects.clear();
    this.available = true;
    this.delayMs = 0;
    this.calls = 0;
  }

  private async step(signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await sleep(this.delayMs, signal);
    if (!this.available) throw new StorageUnavailable(`${this.name}: memory storage is down`);
  }

  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    validateKey(key);
    this.calls += 1;
    await this.step(options.signal);
    const hashing = new HashingStream(chunks);
    const parts: Buffer[] = [];
    for await (const chunk of hashing) {
      await this.step(options.signal);
      parts.push(Buffer.from(chunk));
    }
    await this.step(options.signal);
    const data = Buffer.concat(parts);
    const result = hashing.result();
    this.objects.set(key, { data, sha256: result.sha256 });
    return result;
  }

  getStream(
    key: string,
    options: StorageCallOptions = {},
  ): AsyncGenerator<Buffer, void, undefined> {
    validateKey(key);
    return this.stream(key, options.signal);
  }

  private async *stream(
    key: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Buffer, void, undefined> {
    this.calls += 1;
    this.openReads += 1;
    try {
      await this.step(signal);
      const stored = this.objects.get(key);
      if (!stored) throw new ObjectNotFound(`${this.name}: no object ${JSON.stringify(key)}`);
      for (let offset = 0; offset < stored.data.length; offset += this.readBlock) {
        if (offset > 0) await this.step(signal);
        yield Buffer.from(stored.data.subarray(offset, offset + this.readBlock));
      }
    } finally {
      this.openReads -= 1;
    }
  }

  async delete(key: string, options: StorageCallOptions = {}): Promise<void> {
    validateKey(key);
    this.calls += 1;
    await this.step(options.signal);
    this.objects.delete(key);
  }

  async health(options: StorageCallOptions = {}): Promise<HealthStatus> {
    if (this.delayMs > 0) {
      try {
        await sleep(this.delayMs, options.signal);
      } catch {
        return { ok: false, latencyMs: this.delayMs, detail: 'memory probe aborted' };
      }
    }
    return this.available
      ? { ok: true, latencyMs: 0, detail: 'memory storage ok' }
      : { ok: false, latencyMs: 0, detail: 'memory storage marked unavailable' };
  }

  async close(): Promise<void> {
    // nothing to release; the objects stay so a closed registry can be inspected in tests
  }

  /** SHA-256 of a stored object (tests). */
  sha256Of(key: string): string | undefined {
    const stored = this.objects.get(key);
    return stored ? createHash('sha256').update(stored.data).digest('hex') : undefined;
  }
}
