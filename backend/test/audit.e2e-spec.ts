import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { fakeSecret } from './constants';
import {
  browser,
  createTestApp,
  createUser,
  login,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';

describe('GET /audit-events', () => {
  let app: NestExpressApplication;
  let admin: string;
  const fileId = randomUUID();
  const list = (cookie: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get('/api/v1/audit-events').query(query).set(browser(cookie));

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ storage: memoryStorages().registry });
    await login(app, 'admin', fakeSecret()); // a failed login
    admin = await loginCookie(app);
    const db = testDb();
    try {
      await db
        .insertInto('audit_log')
        .values({
          actor: 'admin',
          action: 'download',
          outcome: 'success',
          category: 'fault_records',
          file_id: fileId,
          trace_id: 'trace-audit-1',
          at: new Date(Date.now() + 1000),
        })
        .execute();
    } finally {
      await db.destroy();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the audit trail newest first in the AuditEvent shape', async () => {
    const response = await list(admin);

    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ page: 1, pageSize: 50, total: 3, hasMore: false });
    const [newest] = response.body.data;
    expect(newest).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      actor: {
        id: expect.any(String),
        username: 'admin',
        displayName: expect.any(String),
        role: 'admin',
      },
      actingAs: null,
      demo: false,
      action: 'download',
      outcome: 'success',
      category: 'fault_records',
      fileId,
      fileDisplayName: null,
      reason: null,
      details: null,
      traceId: 'trace-audit-1',
    });
    const times = response.body.data.map((event: { at: string }) => Date.parse(event.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('filters by action, actor, file and time, and pages', async () => {
    const failures = await list(admin, { action: 'login', actor: 'admin' });
    const byFile = await list(admin, { fileId });
    const future = await list(admin, { from: new Date(Date.now() + 60_000).toISOString() });
    const past = await list(admin, { to: new Date(Date.now() - 60_000).toISOString() });
    const paged = await list(admin, { pageSize: '1', page: '2' });

    expect(failures.body.data.map((e: { outcome: string }) => e.outcome).sort()).toEqual([
      'failure',
      'success',
    ]);
    expect(byFile.body.data).toHaveLength(1);
    expect(future.body.meta.total).toBe(0);
    expect(past.body.meta.total).toBe(0);
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 3, hasMore: true });
  });

  it('rejects an unknown action filter', async () => {
    const response = await list(admin, { action: 'drop_tables' });

    expect(response.status).toBe(422);
  });

  it('is only for roles with view_audit', async () => {
    const password = await createUser('ana-teren', 'teren');
    const teren = await loginCookie(app, 'ana-teren', password);

    const response = await list(teren);

    expect(response.status).toBe(403);
  });
});
