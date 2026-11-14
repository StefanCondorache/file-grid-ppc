import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';

const SECOND = 1000;

/** One meter batch `agoMs` before now (the periods are built from these rows). */
async function batches(origin: 'simulator' | 'storm', agoMs: readonly number[]): Promise<void> {
  const db = testDb();
  try {
    await db
      .insertInto('meter_batches')
      .values(
        agoMs.map((ago, i) => ({
          at: new Date(Date.now() - ago),
          received: origin === 'storm' ? 100 : 10,
          stored: origin === 'storm' ? 100 : 10,
          duplicates: 0,
          origin,
          trace_id: `trace-${origin}-${ago}-${i}`,
        })),
      )
      .execute();
  } finally {
    await db.destroy();
  }
}

/** Batches every 5 s from `fromAgoMs` down to `toAgoMs` (both included). */
const every5s = (fromAgoMs: number, toAgoMs: number): number[] =>
  Array.from(
    { length: Math.floor((fromAgoMs - toAgoMs) / (5 * SECOND)) + 1 },
    (_, i) => fromAgoMs - i * 5 * SECOND,
  );

interface PeriodBody {
  id: string;
  kind: 'normal' | 'peak';
  start: string;
  end: string | null;
}

describe('statistics: periods and the period comparison', () => {
  let app: NestExpressApplication;
  let admin: string;
  const get = (path: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).query(query).set(browser(admin));

  beforeAll(async () => {
    app = await createTestApp({ storage: memoryStorages().registry });
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await loginCookie(app);
    // A finished normal period (10 min ago, 2 min long), then a storm that is still running.
    await batches('simulator', every5s(12 * 60 * SECOND, 10 * 60 * SECOND));
    await batches('storm', every5s(90 * SECOND, 10 * SECOND));
  });

  afterAll(async () => {
    await app.close();
  });

  const periods = async (): Promise<PeriodBody[]> => {
    const response = await get('/statistics/periods');
    expect(response.status).toBe(200);
    return response.body.data as PeriodBody[];
  };

  it('lists the running storm first, open-ended, after the finished normal period', async () => {
    const [storm, normal] = await periods();

    expect(storm).toMatchObject({ kind: 'peak', end: null });
    expect(normal).toMatchObject({ kind: 'normal', end: expect.any(String) });
  });

  it('keeps the id of the running period while new batches extend it', async () => {
    const before = await periods();
    await batches('storm', [5 * SECOND, 0]);
    const after = await periods();

    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
  });

  it('compares a finished period with the newest, still-running one', async () => {
    const [storm, normal] = await periods();
    // The storm goes on after the client read the period list.
    await batches('storm', [5 * SECOND, 0]);

    const response = await get('/statistics/period-comparison', { a: normal.id, b: storm.id });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      periodA: { id: normal.id, kind: 'normal' },
      periodB: { id: storm.id, kind: 'peak', end: null },
      interpretation: { text: expect.any(String), facts: expect.any(Object) },
    });
    expect(response.body.rows).toHaveLength(16);
    const meter = (metric: string) =>
      response.body.rows.find(
        (r: { category: string; metric: string }) =>
          r.category === 'meter_readings' && r.metric === metric,
      );
    expect(meter('opsPerS').b).toBeGreaterThan(meter('opsPerS').a);
  });

  it('still accepts an id in the old start-end form', async () => {
    const [storm, normal] = await periods();
    const legacy = `${new Date(storm.start).getTime()}-${Date.now() - 60 * SECOND}`;

    const response = await get('/statistics/period-comparison', { a: normal.id, b: legacy });

    expect(response.status).toBe(200);
    expect(response.body.periodB.id).toBe(storm.id);
  });

  it('answers 404 for a period that does not exist', async () => {
    const [, normal] = await periods();

    const response = await get('/statistics/period-comparison', { a: normal.id, b: '42' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
