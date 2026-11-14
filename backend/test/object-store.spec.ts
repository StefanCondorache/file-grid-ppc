import { AppError } from '../src/common/app-error';
import { ObjectStoreService } from '../src/object-store/object-store.service';
import {
  type HealthStatus,
  type PutResult,
  type StorageCallOptions,
  StorageBusy,
  StorageUnavailable,
} from '../src/storage/base';
import { MemoryStorage } from '../src/storage/memory';
import { StorageRegistry } from '../src/storage/registry';

/** Like the S3 adapter: buffers (reads) the body before it finds out that the server is gone. */
class BufferingStorage extends MemoryStorage {
  down = false;
  puts = 0;

  override async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    this.puts += 1;
    if (this.down) {
      for await (const _chunk of chunks) {
        // consumed, as S3 does while it fills a part
      }
      throw new StorageUnavailable(`${this.name}: connection refused`);
    }
    return super.putStream(key, chunks, options);
  }

  override async health(): Promise<HealthStatus> {
    return this.down
      ? { ok: false, latencyMs: 1, detail: `${this.name}: connection refused` }
      : { ok: true, latencyMs: 1, detail: 'ok' };
  }
}

/** A one-shot HTTP-like body: it can be read only once. */
function oneShot(data: Buffer): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (used) throw new Error('the request body was already read');
      used = true;
      yield data;
    },
  };
}

const PLACEMENT = { primary: 's3', fallback: 'db', encrypted: false } as const;

describe('ObjectStoreService.writeOnce (part uploads)', () => {
  let s3: BufferingStorage;
  let db: MemoryStorage;
  let registry: StorageRegistry;
  let store: ObjectStoreService;

  beforeEach(() => {
    s3 = new BufferingStorage('s3');
    db = new MemoryStorage('db');
    registry = StorageRegistry.fromAdapters([s3, new MemoryStorage('ftp'), db]);
    store = new ObjectStoreService(registry, null);
  });

  it('writes to the primary while it is healthy', async () => {
    const written = await store.writeOnce(
      'fault_records',
      'staging/u/1',
      PLACEMENT,
      oneShot(Buffer.from('a')),
    );

    expect(written).toMatchObject({ storage: 's3', usedFallback: false });
  });

  it('goes straight to the fallback when the health monitor knows the primary is down', async () => {
    s3.down = true;
    await registry.monitor.checkOnce();
    const putsBefore = s3.puts;

    const written = await store.writeOnce(
      'fault_records',
      'staging/u/1',
      PLACEMENT,
      oneShot(Buffer.from('parte')),
    );

    expect(written).toMatchObject({ storage: 'db', usedFallback: true });
    expect(s3.puts).toBe(putsBefore);
    expect(db.read('staging/u/1').toString()).toBe('parte');
  });

  it('goes straight to the fallback when the primary circuit is open', async () => {
    registry.get('s3').breaker.trip();

    const written = await store.writeOnce(
      'fault_records',
      'staging/u/1',
      PLACEMENT,
      oneShot(Buffer.from('x')),
    );

    expect(written).toMatchObject({ storage: 'db', usedFallback: true });
  });

  it('answers 503 STORAGE_UNAVAILABLE when an unknown outage consumed the body', async () => {
    s3.down = true;

    await expect(
      store.writeOnce('fault_records', 'staging/u/1', PLACEMENT, oneShot(Buffer.from('x'))),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });

  it('still tries the primary when the fallback is known down too', async () => {
    s3.down = true;
    db.setAvailable(false);
    await registry.monitor.checkOnce();

    const failure = await store
      .writeOnce('fault_records', 'staging/u/1', PLACEMENT, oneShot(Buffer.from('x')))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(s3.puts).toBe(1);
  });
});

describe('ObjectStoreService with a busy storage', () => {
  class BusyStorage extends MemoryStorage {
    override async putStream(): Promise<PutResult> {
      throw new StorageBusy(`${this.name}: every pooled connection is in use`);
    }

    override getStream(): AsyncGenerator<Buffer, void, undefined> {
      const name = this.name;
      return (async function* () {
        yield* [];
        throw new StorageBusy(`${name}: every pooled connection is in use`);
      })();
    }
  }

  const busyStore = () =>
    new ObjectStoreService(
      StorageRegistry.fromAdapters([
        new MemoryStorage('s3'),
        new MemoryStorage('ftp'),
        new BusyStorage('db'),
      ]),
      null,
    );
  const onDb = { primary: 'db', fallback: 's3', encrypted: false } as const;

  it('answers 503 CATEGORY_BUSY with Retry-After instead of falling back or blaming the storage', async () => {
    const store = busyStore();

    const failure = (await store
      .writeOnce('meter_readings', 'staging/u/1', onDb, oneShot(Buffer.from('x')))
      .catch((error: unknown) => error)) as AppError;
    const again = (await store
      .write('meter_readings', 'm/1.jsonl', onDb, () => oneShot(Buffer.from('x')))
      .catch((error: unknown) => error)) as AppError;

    expect(failure).toMatchObject({ status: 503, code: 'CATEGORY_BUSY' });
    expect(failure.headers['Retry-After']).toBeDefined();
    expect(again).toMatchObject({ status: 503, code: 'CATEGORY_BUSY' });
  });

  it('answers 503 CATEGORY_BUSY for a read that finds the pool full', async () => {
    const store = busyStore();
    const reading = store.read('meter_readings', {
      storage: 'db',
      key: 'm/1.jsonl',
      encrypted: false,
      storedSha256: 'a'.repeat(64),
    });

    await expect(reading.next()).rejects.toMatchObject({ status: 503, code: 'CATEGORY_BUSY' });
  });
});
