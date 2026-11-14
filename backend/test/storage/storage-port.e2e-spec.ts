import { createHash, randomBytes } from 'node:crypto';
import {
  DecryptionError,
  SEGMENT_SIZE,
  decryptStream,
  encryptStream,
} from '../../src/crypto/envelope';
import { Kek, Keyring } from '../../src/crypto/keys';
import {
  IntegrityError,
  ObjectNotFound,
  StorageUnavailable,
  verifyStream,
} from '../../src/storage/base';
import { DbSettings } from '../../src/storage/config';
import { DbStorage } from '../../src/storage/db';
import { MemoryStorage } from '../../src/storage/memory';
import { CircuitBreaker, CircuitOpenError, ResilientStorage } from '../../src/storage/resilience';
import { testDatabaseUrl } from '../helpers';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function* chunksOf(data: Buffer, size = 10_000): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size)
    yield data.subarray(offset, offset + size);
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('FGE1 envelope encryption', () => {
  const kek = Kek.generate('k1');

  it.each([0, 1, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, 3 * SEGMENT_SIZE, 200_000])(
    'round-trips %i bytes',
    async (size) => {
      const plain = randomBytes(size);

      const sealed = await collect(encryptStream(chunksOf(plain), kek));
      const opened = await collect(decryptStream(chunksOf(sealed, 7777), new Keyring(kek)));

      expect(sealed.subarray(0, 4).toString()).toBe('FGE1');
      expect(opened.equals(plain)).toBe(true);
    },
  );

  it.each([
    [
      'a flipped byte',
      (b: Buffer) => {
        b[b.length - 20] ^= 1;
        return b;
      },
    ],
    ['a truncated end', (b: Buffer) => b.subarray(0, b.length - 1)],
    ['an appended byte', (b: Buffer) => Buffer.concat([b, Buffer.from([0])])],
    [
      'a dropped segment',
      (b: Buffer) => Buffer.concat([b.subarray(0, 79), b.subarray(79 + SEGMENT_SIZE + 16)]),
    ],
  ])('detects %s', async (_label, tamper) => {
    const sealed = await collect(encryptStream(chunksOf(randomBytes(3 * SEGMENT_SIZE + 5)), kek));

    await expect(
      collect(decryptStream(chunksOf(tamper(Buffer.from(sealed))), kek)),
    ).rejects.toThrow(DecryptionError);
  });

  it('refuses the wrong key and decrypts with a retired one', async () => {
    const sealed = await collect(encryptStream(chunksOf(Buffer.from('date personale')), kek));
    const rotated = new Keyring(Kek.generate('k2'), [kek]);

    await expect(collect(decryptStream(chunksOf(sealed), Kek.generate('k1')))).rejects.toThrow(
      DecryptionError,
    );
    expect((await collect(decryptStream(chunksOf(sealed), rotated))).toString()).toBe(
      'date personale',
    );
  });

  it('reads FILEGRID_KEK without ever showing it', () => {
    const value = randomBytes(32).toString('base64');
    const ring = Keyring.fromEnv({ FILEGRID_KEK: value, FILEGRID_KEK_ID: 'k7' });

    expect(ring.primary.keyId).toBe('k7');
    expect(JSON.stringify(ring)).not.toContain(value);
    expect(() => Keyring.fromEnv({ FILEGRID_KEK: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});

describe('verifyStream', () => {
  it('passes matching bytes and throws IntegrityError at the end on a mismatch', async () => {
    const data = randomBytes(50_000);

    await expect(collect(verifyStream(chunksOf(data), sha256(data)))).resolves.toEqual(data);
    await expect(collect(verifyStream(chunksOf(data), 'a'.repeat(64)))).rejects.toThrow(
      IntegrityError,
    );
  });
});

describe('circuit breaker around a storage', () => {
  it('opens after consecutive failures and then rejects instantly without calling the storage', async () => {
    const memory = new MemoryStorage('s3');
    const storage = new ResilientStorage(memory, {
      breaker: new CircuitBreaker('s3', { failureThreshold: 3, resetTimeoutMs: 60_000 }),
    });
    memory.setAvailable(false);

    for (let i = 0; i < 3; i += 1) {
      await expect(storage.putStream('k', chunksOf(Buffer.from('x')))).rejects.toThrow(
        StorageUnavailable,
      );
    }
    const callsBefore = memory.calls;
    await expect(storage.putStream('k', chunksOf(Buffer.from('x')))).rejects.toThrow(
      CircuitOpenError,
    );
    expect(memory.calls).toBe(callsBefore);
    expect(storage.breaker.stateName).toBe('open');
  });

  it('counts ObjectNotFound as a storage that answered', async () => {
    const storage = new ResilientStorage(new MemoryStorage('db'), {
      breaker: new CircuitBreaker('db', { failureThreshold: 1 }),
    });

    await expect(collect(storage.getStream('missing'))).rejects.toThrow(ObjectNotFound);
    expect(storage.breaker.stateName).toBe('closed');
  });
});

describe('DbStorage (PostgreSQL blobstore)', () => {
  let storage: DbStorage;

  beforeAll(() => {
    storage = new DbStorage(new DbSettings({ dsn: testDatabaseUrl(), chunkSize: 64 * 1024 }));
  });

  afterAll(async () => {
    await storage.close();
  });

  it('stores a multi-row object, replaces it atomically and deletes it idempotently', async () => {
    const first = randomBytes(200_000);
    const second = randomBytes(1000);

    const put = await storage.putStream('test/blob.bin', chunksOf(first));
    expect(put).toEqual({ size: first.length, sha256: sha256(first) });
    expect((await collect(storage.getStream('test/blob.bin'))).equals(first)).toBe(true);

    await storage.putStream('test/blob.bin', chunksOf(second));
    expect((await collect(storage.getStream('test/blob.bin'))).equals(second)).toBe(true);

    await storage.delete('test/blob.bin');
    await storage.delete('test/blob.bin');
    await expect(collect(storage.getStream('test/blob.bin'))).rejects.toThrow(ObjectNotFound);
  });

  it('keeps the old object when a write fails midway', async () => {
    await storage.putStream('test/keep.bin', chunksOf(Buffer.from('old')));
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(100_000);
      throw new Error('client went away');
    }

    await expect(storage.putStream('test/keep.bin', failing())).rejects.toThrow();
    expect((await collect(storage.getStream('test/keep.bin'))).toString()).toBe('old');
  });

  it('reports health', async () => {
    expect((await storage.health()).ok).toBe(true);
  });
});
