import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { UploadsService } from '../src/uploads/uploads.service';
import {
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';
import { sleep } from './sse';

const MiB = 1024 * 1024;
const FAULT = {
  kind: 'fault',
  zone: 'banat',
  substation: 'Stația Test',
  eventTime: '2026-11-14T10:00:00Z',
  severity: 'low',
};

describe('abandoned uploads: expired sessions lose their staged parts', () => {
  let app: NestExpressApplication;
  let admin: string;
  const storages = memoryStorages();
  const server = () => app.getHttpServer();
  const staged = () =>
    storages
      .adapter('s3')
      .keys()
      .filter((key) => key.startsWith('staging/'));

  /** An upload of two parts with only part 1 sent: what a closed browser tab leaves behind. */
  async function abandoned(): Promise<string> {
    const part = Buffer.alloc(MiB, 3);
    const created = await request(server())
      .post('/api/v1/uploads')
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'test-sweep.pdf',
        fileSize: 2 * 5 * MiB,
        mimeType: 'application/pdf',
        metadata: FAULT,
      });
    const { uploadId } = created.body;
    const sent = await request(server())
      .put(`/api/v1/uploads/${uploadId}/parts/1`)
      .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
      .send(Buffer.concat([part, Buffer.alloc(4 * MiB, 3)]));
    expect(sent.status).toBe(200);
    return uploadId;
  }

  async function backdate(uploadId: string, status?: 'expired'): Promise<void> {
    const db = testDb();
    try {
      await db
        .updateTable('upload_sessions')
        .set({ expires_at: new Date(Date.now() - 60_000), ...(status ? { status } : {}) })
        .where('id', '=', uploadId)
        .execute();
    } finally {
      await db.destroy();
    }
  }

  async function partRows(uploadId: string): Promise<number> {
    const db = testDb();
    try {
      return (
        await db
          .selectFrom('upload_parts')
          .select('part_number')
          .where('upload_id', '=', uploadId)
          .execute()
      ).length;
    } finally {
      await db.destroy();
    }
  }

  beforeAll(async () => {
    app = await createTestApp({
      storage: storages.registry,
      env: { UPLOAD_SWEEP_INTERVAL_S: '0.5' },
    });
  });

  beforeEach(async () => {
    await resetDatabase();
    await storages.reset();
    admin = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('expires an open session past its expiry and drops its staged parts', async () => {
    const old = await abandoned();
    const fresh = await abandoned();
    await backdate(old);

    await app.get(UploadsService).sweepExpired();

    const status = await request(server()).get(`/api/v1/uploads/${old}`).set(browser(admin));
    expect(status.body.status).toBe('expired');
    expect(await partRows(old)).toBe(0);
    expect(await partRows(fresh)).toBe(1);
    expect(staged()).toEqual([`staging/${fresh}/1`]);
  });

  it('also drops the parts of a session that was marked expired when it was touched', async () => {
    const touched = await abandoned();
    await backdate(touched, 'expired');

    await app.get(UploadsService).sweepExpired();

    expect(await partRows(touched)).toBe(0);
    expect(staged()).toEqual([]);
  });

  it('keeps the part while its storage cannot delete it, and drops it once it can', async () => {
    const old = await abandoned();
    await backdate(old);
    storages.adapter('s3').setAvailable(false);

    await app.get(UploadsService).sweepExpired();
    expect(await partRows(old)).toBe(1);

    storages.adapter('s3').setAvailable(true);
    await app.get(UploadsService).sweepExpired();
    expect(await partRows(old)).toBe(0);
    expect(staged()).toEqual([]);
  });

  it('runs by itself every UPLOAD_SWEEP_INTERVAL_S', async () => {
    const old = await abandoned();
    await backdate(old);

    for (let i = 0; i < 40 && staged().length > 0; i += 1) await sleep(100);

    expect(staged()).toEqual([]);
  });
});
