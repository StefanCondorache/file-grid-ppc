import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FtpSrv } from 'ftp-srv';
import { ObjectNotFound, StorageUnavailable } from '../../src/storage/base';
import { FtpSettings } from '../../src/storage/config';
import { FtpStorage } from '../../src/storage/ftp';
import { fakeSecret } from '../constants';

const FTP_PASSWORD = fakeSecret();

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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** The real FTP adapter against ftp-srv, an in-process FTP server (no containers). */
describe('FtpStorage against an FTP server', () => {
  let server: FtpSrv;
  let storage: FtpStorage;

  beforeAll(async () => {
    const port = await freePort();
    const root = mkdtempSync(join(tmpdir(), 'fg-ftp-'));
    server = new FtpSrv({
      url: `ftp://127.0.0.1:${port}`,
      pasv_url: '127.0.0.1',
      pasv_min: 31000,
      pasv_max: 31100,
      anonymous: false,
      log: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      } as never,
    });
    server.on('login', ({ username, password }, resolve, reject) => {
      if (username === 'filegrid' && password === FTP_PASSWORD) resolve({ root });
      else reject(new Error('bad login'));
    });
    await server.listen();
    storage = new FtpStorage(
      new FtpSettings({
        host: '127.0.0.1',
        port,
        user: 'filegrid',
        password: FTP_PASSWORD,
        maxConnections: 2,
      }),
    );
  });

  afterAll(async () => {
    await storage.close();
    await server.close();
  });

  it('streams an object into nested directories and back', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 17);

    const put = await storage.putStream('drone_videos/2026/11/14/zbor.bin', chunksOf(data));
    const back = await collect(storage.getStream('drone_videos/2026/11/14/zbor.bin'));

    expect(put).toEqual({ size: data.length, sha256: sha256(data) });
    expect(sha256(back)).toBe(sha256(data));
  });

  it('replaces an object, deletes idempotently and reports a missing one', async () => {
    await storage.putStream('t/replace.bin', chunksOf(Buffer.from('first')));
    await storage.putStream('t/replace.bin', chunksOf(Buffer.from('second')));

    expect((await collect(storage.getStream('t/replace.bin'))).toString()).toBe('second');
    await storage.delete('t/replace.bin');
    await storage.delete('t/replace.bin');
    await expect(collect(storage.getStream('t/replace.bin'))).rejects.toThrow(ObjectNotFound);
  });

  it('keeps working after a download stopped early', async () => {
    await storage.putStream('t/early.bin', chunksOf(randomBytes(2 * 1024 * 1024)));

    for await (const _chunk of storage.getStream('t/early.bin')) break;

    expect((await collect(storage.getStream('t/early.bin'))).length).toBe(2 * 1024 * 1024);
    expect((await storage.health()).ok).toBe(true);
  });

  it('fails with StorageUnavailable when the server is unreachable', async () => {
    const dead = new FtpStorage(
      new FtpSettings({
        host: '127.0.0.1',
        port: 1,
        user: 'x',
        password: 'y',
        connectTimeoutMs: 1000,
      }),
    );

    await expect(dead.putStream('t/x.bin', chunksOf(Buffer.from('x')))).rejects.toThrow(
      StorageUnavailable,
    );
    expect((await dead.health()).ok).toBe(false);
    await dead.close();
  });
});
