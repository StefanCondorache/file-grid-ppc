import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import { ObjectNotFound, StorageUnavailable } from '../../src/storage/base';
import { S3Settings } from '../../src/storage/config';
import { S3Storage } from '../../src/storage/s3';

const MiB = 1024 * 1024;
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function* chunksOf(data: Buffer, size = 256 * 1024): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size)
    yield data.subarray(offset, offset + size);
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

/** The real S3 adapter against s3rver, an in-process S3-compatible server (no containers). */
describe('S3Storage against an S3-compatible server', () => {
  let server: S3rver;
  let storage: S3Storage;
  let endpoint: string;

  beforeAll(async () => {
    server = new S3rver({
      address: '127.0.0.1',
      port: 0,
      silent: true,
      directory: mkdtempSync(join(tmpdir(), 'fg-s3rver-')),
      configureBuckets: [{ name: 'filegrid', configs: [] }],
    });
    const address = await server.run();
    endpoint = `http://127.0.0.1:${address.port}`;
    storage = new S3Storage(
      new S3Settings({
        endpoint: `http://127.0.0.1:${address.port}`,
        // s3rver's built-in public test key (the in-process fake server accepts only this one);
        // it is not a credential of any real storage.
        accessKey: 'S3RVER',
        secretKey: 'S3RVER',
        bucket: 'filegrid',
        partSize: 5 * MiB,
      }),
    );
  });

  afterAll(async () => {
    await storage.close();
    await server.close();
  });

  it('puts and gets a small object with its SHA-256', async () => {
    const data = randomBytes(1000);

    const put = await storage.putStream('fault_records/2026/11/14/small.bin', chunksOf(data));

    expect(put).toEqual({ size: 1000, sha256: sha256(data) });
    expect(
      (await collect(storage.getStream('fault_records/2026/11/14/small.bin'))).equals(data),
    ).toBe(true);
  });

  it('uses a multipart upload for objects larger than one part', async () => {
    const data = randomBytes(12 * MiB + 321);

    const put = await storage.putStream('drone_videos/2026/11/14/big.bin', chunksOf(data));
    const back = await collect(storage.getStream('drone_videos/2026/11/14/big.bin'));

    expect(put.sha256).toBe(sha256(data));
    expect(sha256(back)).toBe(sha256(data));
  });

  it('replaces an object and deletes idempotently', async () => {
    await storage.putStream('t/replace.bin', chunksOf(Buffer.from('first')));
    await storage.putStream('t/replace.bin', chunksOf(Buffer.from('second')));

    expect((await collect(storage.getStream('t/replace.bin'))).toString()).toBe('second');
    await storage.delete('t/replace.bin');
    await storage.delete('t/replace.bin');
    await expect(collect(storage.getStream('t/replace.bin'))).rejects.toThrow(ObjectNotFound);
  });

  it('stops reading early without breaking the next request', async () => {
    await storage.putStream('t/early.bin', chunksOf(randomBytes(6 * MiB)));

    for await (const _chunk of storage.getStream('t/early.bin')) break;

    expect((await storage.health()).ok).toBe(true);
  });

  it('waits for a slow consumer: the read timeout runs only while waiting on S3', async () => {
    const data = randomBytes(8 * MiB);
    const patient = new S3Storage(
      new S3Settings({
        endpoint,
        accessKey: 'S3RVER',
        secretKey: 'S3RVER',
        bucket: 'filegrid',
        readTimeoutMs: 300,
      }),
    );
    try {
      await patient.putStream('t/slow-consumer.bin', chunksOf(data));
      const reading = patient.getStream('t/slow-consumer.bin')[Symbol.asyncIterator]();
      const first = await reading.next();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // the client holds the chunk

      const rest = await collect({ [Symbol.asyncIterator]: () => reading });

      expect(sha256(Buffer.concat([first.value as Buffer, rest]))).toBe(sha256(data));
    } finally {
      await patient.close();
    }
  });

  it('still times out when S3 itself stops sending', async () => {
    const stalled: Server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '1000' });
      response.write(Buffer.alloc(10));
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const { port } = stalled.address() as AddressInfo;
    const s3 = new S3Storage(
      new S3Settings({
        endpoint: `http://127.0.0.1:${port}`,
        accessKey: 'x',
        secretKey: 'y',
        bucket: 'filegrid',
        readTimeoutMs: 300,
      }),
    );
    try {
      const started = Date.now();
      await expect(collect(s3.getStream('t/stalled.bin'))).rejects.toThrow(StorageUnavailable);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await s3.close();
      stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });

  it('fails fast with StorageUnavailable when the endpoint is down', async () => {
    const dead = new S3Storage(
      new S3Settings({
        endpoint: 'http://127.0.0.1:1',
        accessKey: 'x',
        secretKey: 'y',
        bucket: 'filegrid',
      }),
    );
    const started = Date.now();

    await expect(dead.putStream('t/x.bin', chunksOf(Buffer.from('x')))).rejects.toThrow(
      StorageUnavailable,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await dead.health()).ok).toBe(false);
    await dead.close();
  });
});
