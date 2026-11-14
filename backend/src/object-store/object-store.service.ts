import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, categoryBusy, retryAfter } from '../common/app-error';
import type { Category, StorageName } from '../common/domain';
import { decryptStream, encryptStream } from '../crypto/envelope';
import type { Keyring } from '../crypto/keys';
import { span } from '../observability/trace-context';
import {
  HashingStream,
  ObjectNotFound,
  type PutResult,
  StorageBusy,
  StorageUnavailable,
  verifyStream,
} from '../storage/base';
import { withCategory } from '../storage/metrics';
import type { StorageRegistry } from '../storage/registry';
import { STORAGE_REGISTRY } from '../storage/storage.module';

export const KEYRING = Symbol('KEYRING');

export interface Placement {
  readonly primary: StorageName;
  readonly fallback: StorageName | null;
  readonly encrypted: boolean;
}

export interface WriteResult {
  readonly storage: StorageName;
  readonly usedFallback: boolean;
  /** Size and SHA-256 of the bytes the storage holds (ciphertext when encrypted). */
  readonly stored: PutResult;
  /** Size and SHA-256 of the original bytes. */
  readonly plain: PutResult;
}

export interface StoredObject {
  readonly storage: StorageName;
  readonly key: string;
  readonly encrypted: boolean;
  readonly storedSha256: string;
}

export function storageUnavailable(storage: StorageName): AppError {
  return new AppError(
    503,
    'STORAGE_UNAVAILABLE',
    `Storage-ul ${storage.toUpperCase()} este indisponibil momentan. Celelalte categorii funcționează; reîncercați.`,
    { storage, retryAfterMs: 5000 },
    retryAfter(5),
  );
}

/** A storage without a free connection (StorageBusy) is overload: 503 CATEGORY_BUSY + Retry-After. */
async function busyAsCategoryBusy<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StorageBusy) throw categoryBusy();
    throw error;
  }
}

async function* busyAsCategoryBusyStream(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer, void, undefined> {
  try {
    yield* chunks;
  } catch (error) {
    if (error instanceof StorageBusy) throw categoryBusy();
    throw error;
  }
}

/**
 * The backend's only door to the storages. Applies a category's placement (primary, then fallback
 * when the primary is unavailable), encrypts and decrypts (FGE1, src/crypto), records spans and the
 * per-category storage metrics, and verifies hashes on every read.
 */
@Injectable()
export class ObjectStoreService {
  private readonly logger = new Logger(ObjectStoreService.name);

  constructor(
    @Inject(STORAGE_REGISTRY) private readonly registry: StorageRegistry,
    @Inject(KEYRING) private readonly keyring: Keyring | null,
  ) {}

  /**
   * Writes a new object. `source()` must give the same bytes every time it is called: it is called
   * again for the fallback when the primary failed after it had started reading.
   */
  async write(
    category: Category,
    key: string,
    placement: Placement,
    source: () => AsyncIterable<Uint8Array>,
  ): Promise<WriteResult> {
    return busyAsCategoryBusy(() => this.writeWithFallback(category, key, placement, source));
  }

  private async writeWithFallback(
    category: Category,
    key: string,
    placement: Placement,
    source: () => AsyncIterable<Uint8Array>,
  ): Promise<WriteResult> {
    const targets = this.skipsPrimary(placement)
      ? [placement.fallback as StorageName]
      : [placement.primary, ...(placement.fallback ? [placement.fallback] : [])];
    let lastError: unknown;
    for (const storage of targets) {
      try {
        const result = await this.writeTo(category, storage, key, placement.encrypted, source);
        return { ...result, storage, usedFallback: storage !== placement.primary };
      } catch (error) {
        if (!(error instanceof StorageUnavailable)) throw error;
        lastError = error;
        this.logger.warn({
          message: 'storage unavailable, trying the policy fallback',
          category,
          storage,
          operation: 'put',
          error: error.message,
        });
      }
    }
    throw lastError instanceof StorageUnavailable
      ? storageUnavailable(placement.primary)
      : lastError;
  }

  /**
   * Writes the caller's one-shot stream (an HTTP body). A primary the health monitor or the circuit
   * breaker already knows to be down is skipped, so the body goes to the fallback at once. Otherwise
   * it falls back only when the primary failed before reading a single byte of it (connection
   * refused): then the untouched body can go to the fallback. A failure mid-stream surfaces as 503
   * and the client resends the part.
   */
  async writeOnce(
    category: Category,
    key: string,
    placement: Placement,
    body: AsyncIterable<Uint8Array>,
  ): Promise<WriteResult> {
    return busyAsCategoryBusy(() => this.writeBody(category, key, placement, body));
  }

  private async writeBody(
    category: Category,
    key: string,
    placement: Placement,
    body: AsyncIterable<Uint8Array>,
  ): Promise<WriteResult> {
    if (this.skipsPrimary(placement)) {
      const fallback = placement.fallback as StorageName;
      try {
        const result = await this.writeTo(category, fallback, key, placement.encrypted, () => body);
        return { ...result, storage: fallback, usedFallback: true };
      } catch (error) {
        if (error instanceof StorageUnavailable) throw storageUnavailable(fallback);
        throw error;
      }
    }
    const iterator = body[Symbol.asyncIterator]();
    let touched = false;
    const tracked: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          touched = true;
          return iterator.next();
        },
        return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
      }),
    };
    try {
      const result = await this.writeTo(
        category,
        placement.primary,
        key,
        placement.encrypted,
        () => tracked,
      );
      return { ...result, storage: placement.primary, usedFallback: false };
    } catch (error) {
      if (!(error instanceof StorageUnavailable)) throw error;
      if (touched || !placement.fallback) throw storageUnavailable(placement.primary);
      this.logger.warn({
        message: 'primary storage refused the part, using the policy fallback',
        category,
        storage: placement.primary,
        operation: 'put',
        error: error.message,
      });
      try {
        const result = await this.writeTo(
          category,
          placement.fallback,
          key,
          placement.encrypted,
          () => tracked,
        );
        return { ...result, storage: placement.fallback, usedFallback: true };
      } catch (fallbackError) {
        if (fallbackError instanceof StorageUnavailable)
          throw storageUnavailable(placement.fallback);
        throw fallbackError;
      }
    }
  }

  /** Plaintext of a stored object. Throws IntegrityError at the end when the stored hash differs. */
  read(category: Category, object: StoredObject, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const stored = withCategory(category, () =>
      this.registry.get(object.storage).getStream(object.key, { signal }),
    );
    const verified = verifyStream(busyAsCategoryBusyStream(stored), object.storedSha256);
    return object.encrypted ? decryptStream(verified, this.requireKeyring()) : verified;
  }

  /**
   * The raw stored bytes (ciphertext for encrypted objects), unverified: for staged parts, demo
   * corruption and byte-range downloads of plain files.
   */
  readRaw(
    category: Category,
    storage: StorageName,
    key: string,
    signal?: AbortSignal,
  ): AsyncIterable<Buffer> {
    return busyAsCategoryBusyStream(
      withCategory(category, () => this.registry.get(storage).getStream(key, { signal })),
    );
  }

  /** Replaces the raw bytes under a key (demo: corrupt a stored file in place). */
  async overwriteRaw(
    category: Category,
    storage: StorageName,
    key: string,
    bytes: Buffer,
  ): Promise<void> {
    await withCategory(category, () =>
      this.registry.get(storage).putStream(
        key,
        (async function* () {
          yield bytes;
        })(),
      ),
    );
  }

  async delete(category: Category, storage: StorageName, key: string): Promise<void> {
    try {
      await withCategory(category, () => this.registry.get(storage).delete(key));
    } catch (error) {
      if (error instanceof ObjectNotFound) return;
      this.logger.warn({
        message: 'could not delete a stored object (left for cleanup)',
        category,
        storage,
        operation: 'delete',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  status() {
    return this.registry.status();
  }

  /** Down for the last health probe, or its circuit is open. */
  private knownDown(storage: StorageName): boolean {
    const status = this.registry.status()[storage];
    return status.up === false || status.circuit === 'open';
  }

  /** Write straight to the fallback: the primary is known down and the fallback is not. */
  private skipsPrimary(placement: Placement): boolean {
    return (
      placement.fallback !== null &&
      this.knownDown(placement.primary) &&
      !this.knownDown(placement.fallback)
    );
  }

  private async writeTo(
    category: Category,
    storage: StorageName,
    key: string,
    encrypted: boolean,
    source: () => AsyncIterable<Uint8Array>,
  ): Promise<Omit<WriteResult, 'storage' | 'usedFallback'>> {
    const keyring = encrypted ? this.requireKeyring() : null;
    return span('storage.put', { storage, category, encrypted }, async (attrs) => {
      const plain = new HashingStream(source());
      const bytes = keyring ? encryptStream(plain, keyring.primary) : plain;
      const stored = await withCategory(category, () =>
        this.registry.get(storage).putStream(key, bytes),
      );
      attrs.sizeBytes = plain.size;
      return { stored, plain: { size: plain.size, sha256: plain.sha256 } };
    });
  }

  private requireKeyring(): Keyring {
    if (!this.keyring) {
      throw new AppError(
        503,
        'ENCRYPTION_UNAVAILABLE',
        'Cheia de criptare nu este configurată; documentele de racordare nu pot fi procesate.',
      );
    }
    return this.keyring;
  }
}
