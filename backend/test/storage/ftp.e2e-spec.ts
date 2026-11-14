import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FtpSrv } from 'ftp-srv';
import { ObjectNotFound, StorageUnavailable } from '../../src/storage/base';
import { FtpSettings } from '../../src/storage/config';
import { FtpStorage } from '../../src/storage/ftp';
import { STORAGE_UP, resetStorageMetrics } from '../../src/storage/metrics';
import { CircuitBreaker, HealthMonitor, ResilientStorage } from '../../src/storage/resilience';
import { fakeSecret } from '../constants';

const FTP_PASSWORD = fakeSecret();
const SLOW_LOGIN_MS = 700;
const PROBE_TIMEOUT_MS = 200;

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
  let port: number;

  beforeAll(async () => {
    port = await freePort();
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
      if (password !== FTP_PASSWORD) reject(new Error('bad login'));
      else if (username === 'filegrid') resolve({ root });
      // pure-ftpd's first login of a new pod takes seconds: longer than one health probe
      else if (username === 'slow') setTimeout(() => resolve({ root }), SLOW_LOGIN_MS);
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

  describe('health probes during a slow login', () => {
    function monitored(user: string, password = FTP_PASSWORD) {
      const adapter = new FtpStorage(
        new FtpSettings({ host: '127.0.0.1', port, user, password, maxConnections: 1 }),
      );
      const resilient = new ResilientStorage(adapter, {
        breaker: new CircuitBreaker('ftp', { failureThreshold: 5, resetTimeoutMs: 60_000 }),
        healthTimeoutMs: PROBE_TIMEOUT_MS,
      });
      return { resilient, monitor: new HealthMonitor([resilient], { tripAfter: 2 }) };
    }
    const up = async (): Promise<number | undefined> =>
      (await STORAGE_UP.get()).values.find((v) => v.labels.storage === 'ftp')?.value;

    beforeEach(() => resetStorageMetrics());

    it('does not count probes that find the health login still running', async () => {
      const { resilient, monitor } = monitored('slow');
      try {
        await monitor.checkOnce();
        await monitor.checkOnce(); // both time out while the login is still in progress

        expect(resilient.breaker.stateName).toBe('closed');
        expect(await up()).not.toBe(0);

        await new Promise((resolve) => setTimeout(resolve, SLOW_LOGIN_MS));
        const done = await monitor.checkOnce();

        expect(done.ftp?.ok).toBe(true);
        expect(await up()).toBe(1);
      } finally {
        await resilient.close();
      }
    });

    it('still counts a login that fails', async () => {
      const { resilient, monitor } = monitored('filegrid', fakeSecret());
      try {
        await monitor.checkOnce();
        await monitor.checkOnce();

        expect(resilient.breaker.stateName).toBe('open');
        expect(await up()).toBe(0);
      } finally {
        await resilient.close();
      }
    });
  });
});
