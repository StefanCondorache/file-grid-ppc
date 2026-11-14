import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { TEST_METER_KEY } from './constants';
import {
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';

function reading(n: number, zone = 'banat', kwh = 1.25) {
  return {
    readingId: `RO-BAN-${String(n).padStart(6, '0')}:${n}`,
    meterId: `RO-BAN-${String(n).padStart(6, '0')}`,
    zone,
    readingTime: '2026-11-14T12:00:00Z',
    kwh,
    sequence: n,
    origin: 'simulator',
  };
}

describe('meter readings', () => {
  let app: NestExpressApplication;
  let storages: ReturnType<typeof memoryStorages>;
  const send = (readings: object[], key = TEST_METER_KEY) =>
    request(app.getHttpServer())
      .post('/api/v1/meter-readings')
      .set('X-API-Key', key)
      .send({ readings });

  beforeAll(async () => {
    storages = memoryStorages();
    app = await createTestApp({ storage: storages.registry });
  });

  beforeEach(async () => {
    await resetDatabase();
    storages.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores a batch once and acknowledges a retry as duplicates, never storing twice', async () => {
    const batch = [reading(1), reading(2), reading(3)];

    const first = await send(batch);
    const retry = await send(batch);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: 3, stored: 3, duplicates: 0 });
    expect(retry.body).toMatchObject({ received: 3, stored: 0, duplicates: 3 });
    const db = testDb();
    try {
      const rows = await db.selectFrom('meter_readings').select('reading_id').execute();
      expect(rows).toHaveLength(3);
      const files = await db
        .selectFrom('files')
        .selectAll()
        .where('category', '=', 'meter_readings')
        .execute();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ storage: 'db', origin: 'simulator' });
    } finally {
      await db.destroy();
    }
    expect(storages.adapter('db').keys()).toHaveLength(1);
  });

  it('counts a reading repeated inside one batch as a duplicate', async () => {
    const response = await send([reading(7), reading(7), reading(8)]);

    expect(response.body).toMatchObject({ received: 3, stored: 2, duplicates: 1 });
  });

  it('stores only the new readings of a partly retried batch', async () => {
    await send([reading(1), reading(2)]);

    const response = await send([reading(2), reading(3)]);

    expect(response.body).toMatchObject({ stored: 1, duplicates: 1 });
  });

  it('exposes the metric contract the alerts use', async () => {
    await send([reading(1), reading(2)]);
    await send([reading(2)]);

    const metrics = await request(app.getHttpServer()).get('/metrics');

    expect(metrics.text).toMatch(/filegrid_meter_readings_stored_total\{zone="banat"\} [1-9]/);
    expect(metrics.text).toMatch(/filegrid_meter_readings_duplicates_total\{zone="banat"\} [1-9]/);
    expect(metrics.text).toContain('filegrid_meter_readings_duplicate_stored_total 0');
    expect(metrics.text).toContain('filegrid_storage_operation_seconds_bucket');
  });

  it('refuses a wrong key and an invalid body', async () => {
    const wrongKey = await send([reading(1)], 'not-the-meter-key-0000');
    const invalid = await send([{ ...reading(1), zone: 'ardeal' }]);
    const empty = await send([]);

    expect(wrongKey.status).toBe(401);
    expect([invalid.status, empty.status]).toEqual([422, 422]);
  });

  it('answers 503 STORAGE_UNAVAILABLE when every storage of the policy is down, so the meter retries', async () => {
    storages.adapter('db').setAvailable(false);
    storages.adapter('s3').setAvailable(false);

    const response = await send([reading(1)]);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lists readings and counters for roles that may see meters', async () => {
    await send([reading(1), reading(2, 'dobrogea')]);
    await send([reading(1)]);
    const cookie = await loginCookie(app);

    const list = await request(app.getHttpServer())
      .get('/api/v1/meter-readings')
      .set(browser(cookie));
    const counters = await request(app.getHttpServer())
      .get('/api/v1/meters/counters')
      .set(browser(cookie));

    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0]).toMatchObject({ storage: 'db', origin: 'simulator' });
    expect(counters.body).toMatchObject({ received: 3, unique: 2, duplicatesRejected: 1 });
  });
});
