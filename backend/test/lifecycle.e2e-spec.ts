import { EventEmitter } from 'node:events';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'kysely';
import request from 'supertest';
import { DB, type Db } from '../src/database/database';
import { BootService } from '../src/lifecycle/boot.service';
import { Lifecycle } from '../src/lifecycle/lifecycle';
import { RetryTimeoutError } from '../src/lifecycle/retry';
import { gracefulShutdown, handleShutdownSignals } from '../src/lifecycle/shutdown';
import {
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDatabaseUrl,
  testDb,
} from './helpers';
import { listen, openStream, sleep } from './sse';
import { TestOnlyModule } from './test-only.module';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A TCP proxy in front of the test Postgres, started late or stopped by the test: a database that
 * is not up yet when the pod starts, or one that goes away later.
 */
async function databaseProxy() {
  const target = new URL(testDatabaseUrl());
  const port = await freePort();
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  const dsn = new URL(testDatabaseUrl());
  dsn.hostname = '127.0.0.1';
  dsn.port = String(port);
  return {
    dsn: dsn.toString(),
    start: async (): Promise<void> => {
      server = createServer((client) => {
        const upstream = connect(Number(target.port), target.hostname);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on('error', () => undefined);
          socket.on('close', () => {
            sockets.delete(socket);
            client.destroy();
            upstream.destroy();
          });
        }
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) => server?.listen(port, '127.0.0.1', resolve));
    },
    stop: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolve) => server?.close(resolve));
    },
  };
}

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

/** One GET on a fresh connection (no keep-alive agent), resolving with the whole answer. */
function get(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}${path}`, { agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('boot: waits for the database instead of exiting', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('serves /healthz, answers /readyz 503 until the database is reachable, then migrates, seeds and turns ready', async () => {
    const proxy = await databaseProxy();
    const app = await createTestApp({ env: { FILEGRID_PG_DSN: proxy.dsn }, waitForBoot: false });
    try {
      // The boot must create the accounts itself once the database is there.
      const db = testDb();
      await db.deleteFrom('users').execute();
      await db.destroy();

      const health = await request(app.getHttpServer()).get('/healthz');
      const starting = await request(app.getHttpServer()).get('/readyz');

      expect(health.status).toBe(200);
      expect(starting.status).toBe(503);
      expect(starting.headers['retry-after']).toBeDefined();
      expect(starting.body).toEqual({ status: 'starting', database: 'error' });
      expect(app.get(Lifecycle).state).toBe('starting');

      await proxy.start();
      await app.get(BootService).ready;
      const ready = await request(app.getHttpServer()).get('/readyz');

      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready', database: 'ok' });
      expect(await loginCookie(app)).toMatch(/fg_session=/);
    } finally {
      await app.close();
      await proxy.stop();
    }
  });

  it('retries a database host that does not resolve and gives up after FILEGRID_DB_BOOT_TIMEOUT_S', async () => {
    const app = await createTestApp({
      env: {
        FILEGRID_PG_DSN: 'postgresql://filegrid:unused@filegrid-db.invalid:5432/filegrid',
        FILEGRID_DB_BOOT_TIMEOUT_S: '2',
      },
      waitForBoot: false,
    });
    try {
      const starting = await request(app.getHttpServer()).get('/readyz');
      const started = Date.now();
      const failure = await app
        .get(BootService)
        .ready.then(() => null)
        .catch((error: unknown) => error);

      expect(starting.status).toBe(503);
      expect(failure).toBeInstanceOf(RetryTimeoutError);
      expect((failure as RetryTimeoutError).attempts).toBeGreaterThan(1);
      expect(String((failure as RetryTimeoutError).lastError)).toMatch(/ENOTFOUND|EAI_AGAIN/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await request(app.getHttpServer()).get('/readyz')).status).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('readiness after boot', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('stays 200 (degraded) when the database goes away later, so the pod keeps serving', async () => {
    const proxy = await databaseProxy();
    await proxy.start();
    const app = await createTestApp({ env: { FILEGRID_PG_DSN: proxy.dsn } });
    try {
      const before = await request(app.getHttpServer()).get('/readyz');
      await proxy.stop();
      const after = await request(app.getHttpServer()).get('/readyz');

      expect(before.body).toEqual({ status: 'ready', database: 'ok' });
      expect(after.status).toBe(200);
      expect(after.body).toEqual({ status: 'degraded', database: 'error' });
    } finally {
      await app.close();
    }
  });
});

describe('graceful shutdown (SIGTERM: rolling update, HPA scale-down)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  /** Set by the tests whose shutdown already closed the app. */
  let closed: boolean;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    app = await createTestApp({
      extraModules: [TestOnlyModule],
      storage: memoryStorages().registry,
    });
    baseUrl = await listen(app);
    closed = false;
  });

  afterEach(async () => {
    if (!closed) await app.close();
  });

  it('answers /readyz 503 once the process is stopping', async () => {
    app.get(Lifecycle).beginStopping();

    const response = await get(baseUrl, '/readyz');

    expect(response.status).toBe(503);
    expect(response.headers.connection).toBe('close');
    expect(JSON.parse(response.body)).toEqual({ status: 'stopping', database: 'ok' });
  });

  it('turns not-ready, refuses new connections, lets in-flight requests finish with the database, then closes the pool', async () => {
    const db = app.get<Db>(DB);
    const inFlight = get(baseUrl, '/api/v1/test-only/slow?ms=600');
    await sleep(150);

    const shutdown = gracefulShutdown(app, { drainTimeoutMs: 10_000 });
    closed = true;

    expect(app.get(Lifecycle).state).toBe('stopping');
    await expect(get(baseUrl, '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, database: 1 });
    await shutdown;
    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow();
  });

  it('waits at most drainTimeoutMs for a request that never ends, then cuts it', async () => {
    const hanging = get(baseUrl, '/api/v1/test-only/hang').then(
      () => 'answered',
      (error: NodeJS.ErrnoException) => error.code ?? error.message,
    );
    await sleep(100);
    const started = Date.now();

    closed = true;
    await gracefulShutdown(app, { drainTimeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(await hanging).toMatch(/ECONNRESET|socket hang up/);
  });

  it('ends the live event streams at once, so they do not hold the drain', async () => {
    const cookie = await loginCookie(app);
    const stream = await openStream(baseUrl, browser(cookie));
    expect(stream.status).toBe(200);
    const started = Date.now();

    closed = true;
    await gracefulShutdown(app, { drainTimeoutMs: 10_000 });
    await stream.ended;

    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('runs the shutdown once on SIGTERM and exits 0 when it is done', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    handleShutdownSignals(app, {
      drainTimeoutMs: 1000,
      target: signals,
      exit: (code) => exits.push(code),
    });

    closed = true;
    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    for (let i = 0; i < 100 && exits.length === 0; i += 1) await sleep(20);

    expect(app.get(Lifecycle).state).toBe('stopping');
    expect(exits).toEqual([0]);
  });
});
