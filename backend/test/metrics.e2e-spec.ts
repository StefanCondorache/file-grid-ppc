import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  browser,
  createTestApp,
  createUser,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';

interface Op {
  category: 'fault_records' | 'drone_videos';
  storage: 's3' | 'ftp';
  status: 'ok' | 'error';
  durationMs: number;
  agoMs?: number;
  sizeBytes?: number;
}

async function operations(ops: Op[]): Promise<void> {
  const db = testDb();
  try {
    await db
      .insertInto('operations')
      .values(
        ops.map((op) => ({
          trace_id: randomUUID().replaceAll('-', ''),
          operation: 'upload.complete',
          category: op.category,
          storage: op.storage,
          status: op.status,
          started_at: new Date(Date.now() - (op.agoMs ?? 1000)),
          duration_ms: op.durationMs,
          size_bytes: op.sizeBytes ?? null,
          spans: '[]',
        })),
      )
      .execute();
  } finally {
    await db.destroy();
  }
}

describe('metrics matrix and bulkhead series', () => {
  let app: NestExpressApplication;
  let admin: string;
  const get = (path: string, query: Record<string, string> = {}, cookie = admin) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).query(query).set(browser(cookie));

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ storage: memoryStorages().registry });
    admin = await loginCookie(app);
    await operations([
      ...Array.from({ length: 10 }, (_, i) => ({
        category: 'fault_records' as const,
        storage: 's3' as const,
        status: 'ok' as const,
        durationMs: (i + 1) * 100,
        sizeBytes: 1000,
      })),
      { category: 'fault_records', storage: 's3', status: 'error', durationMs: 50 },
      { category: 'fault_records', storage: 's3', status: 'error', durationMs: 50 },
      { category: 'drone_videos', storage: 'ftp', status: 'ok', durationMs: 2000 },
      {
        category: 'drone_videos',
        storage: 'ftp',
        status: 'ok',
        durationMs: 4000,
        agoMs: 2 * 3_600_000,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers one cell per category x storage over the window', async () => {
    const response = await get('/metrics/matrix', { window: '5m' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ window: '5m', generatedAt: expect.any(String) });
    expect(response.body.cells).toHaveLength(12);
    const cell = (category: string, storage: string) =>
      response.body.cells.find(
        (c: { category: string; storage: string }) =>
          c.category === category && c.storage === storage,
      );
    expect(cell('fault_records', 's3')).toMatchObject({
      requests: 12,
      noTraffic: false,
      errorRate: 2 / 12,
      opsPerS: 12 / 300,
    });
    expect(cell('fault_records', 's3').p95Ms).toBeGreaterThan(cell('fault_records', 's3').p50Ms);
    expect(cell('fault_records', 's3').throughputBps).toBeGreaterThan(0);
    expect(cell('drone_videos', 'ftp')).toMatchObject({ requests: 1, p95Ms: 2000 });
    expect(cell('meter_readings', 'db')).toMatchObject({
      requests: 0,
      noTraffic: true,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      opsPerS: null,
      errorRate: null,
    });
  });

  it('widens the window to 24h and rejects an unknown window', async () => {
    const day = await get('/metrics/matrix', { window: '24h' });
    const wrong = await get('/metrics/matrix', { window: '2d' });

    const drone = day.body.cells.find(
      (c: { category: string; storage: string }) =>
        c.category === 'drone_videos' && c.storage === 'ftp',
    );
    expect(drone.requests).toBe(2);
    expect(wrong.status).toBe(422);
  });

  it('adds per-category p95 and ops/s series to the live bulkhead state', async () => {
    const response = await get('/metrics/bulkhead', { window: '5m' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ window: '5m', stepS: 10 });
    expect(response.body.data).toHaveLength(4);
    expect(response.body.series.map((s: { category: string }) => s.category).sort()).toEqual([
      'connection_documents',
      'drone_videos',
      'fault_records',
      'meter_readings',
    ]);
    const fault = response.body.series.find(
      (s: { category: string }) => s.category === 'fault_records',
    );
    expect(fault.points).toHaveLength(30);
    const busy = fault.points.filter((p: { opsPerS: number }) => p.opsPerS > 0);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(
      busy.reduce((sum: number, p: { opsPerS: number }) => sum + p.opsPerS * 10, 0),
    ).toBeCloseTo(12);
    const quiet = response.body.series.find(
      (s: { category: string }) => s.category === 'meter_readings',
    );
    expect(quiet.points.every((p: { p95Ms: number | null }) => p.p95Ms === null)).toBe(true);
  });

  it('uses a 15 minute window with 30 s steps by default', async () => {
    const response = await get('/metrics/bulkhead');

    expect(response.body).toMatchObject({ window: '15m', stepS: 30 });
  });

  it('needs view_observability', async () => {
    const password = await createUser('teo-teren', 'teren');
    const teren = await loginCookie(app, 'teo-teren', password);

    expect((await get('/metrics/matrix', {}, teren)).status).toBe(403);
  });
});
