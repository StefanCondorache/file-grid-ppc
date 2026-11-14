import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { browser, createTestApp, createUser, loginCookie, resetDatabase, testDb } from './helpers';

const MiB = 1024 * 1024;

function update(overrides: Record<string, unknown> = {}) {
  return {
    baseVersion: 1,
    primaryStorage: 'db',
    fallbackStorage: 's3',
    encryptionAtRest: false,
    chunkSize: 8 * MiB,
    maxParallel: 3,
    maxConcurrency: 2,
    maxFileSize: 100 * MiB,
    allowedTypes: ['application/pdf'],
    retentionDays: 30,
    ...overrides,
  };
}

describe('policies', () => {
  let app: NestExpressApplication;
  let admin: string;
  const put = (cookie: string, category: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put(`/api/v1/policies/${category}`)
      .set(browser(cookie))
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the four seeded policies in category order', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/policies').set(browser(admin));

    expect(response.status).toBe(200);
    expect(response.body.data.map((p: { category: string }) => p.category)).toEqual([
      'meter_readings',
      'fault_records',
      'connection_documents',
      'drone_videos',
    ]);
    expect(response.body.data[2]).toMatchObject({
      primaryStorage: 's3',
      fallbackStorage: 'db',
      encryptionAtRest: true,
      encryptionLocked: true,
      encryptionAlgorithm: 'AES-256-GCM',
      version: 1,
      updatedBy: { username: 'system' },
    });
  });

  it('changes a policy live and bumps its version', async () => {
    const response = await put(admin, 'fault_records', update());
    const read = await request(app.getHttpServer())
      .get('/api/v1/policies/fault_records')
      .set(browser(admin));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: 2,
      primaryStorage: 'db',
      chunkSize: 8 * MiB,
      maxConcurrency: 2,
      updatedBy: { username: 'admin', role: 'admin' },
    });
    expect(read.body).toEqual(response.body);
  });

  it('shows the policy of every version in the GET /policies shape, the seeded first one too', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/policies/fault_records')
      .set(browser(admin));
    const saved = await put(admin, 'fault_records', update());

    const versions = await request(app.getHttpServer())
      .get('/api/v1/policies/fault_records/versions')
      .set(browser(admin));

    const [second, first] = versions.body.data;
    expect(second.policy).toEqual({ ...saved.body, updatedAt: second.changedAt });
    expect(first.policy).toEqual({ ...before.body, updatedAt: first.changedAt });
  });

  it('records each version with the changed fields and audits the change', async () => {
    await put(admin, 'fault_records', update());

    const versions = await request(app.getHttpServer())
      .get('/api/v1/policies/fault_records/versions')
      .set(browser(admin));

    expect(versions.body.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions.body.data[0].changes).toEqual(
      expect.arrayContaining([{ field: 'primaryStorage', from: 's3', to: 'db' }]),
    );
    const db = testDb();
    try {
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'policy_update')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toContain('chunkSize 5 MiB → 8 MiB');
    } finally {
      await db.destroy();
    }
  });

  it('answers a stale baseVersion with 409 and the current policy', async () => {
    await put(admin, 'fault_records', update());

    const stale = await put(admin, 'fault_records', update({ chunkSize: 16 * MiB }));

    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('POLICY_VERSION_CONFLICT');
    expect(stale.body.currentPolicy).toMatchObject({ version: 2, chunkSize: 8 * MiB });
  });

  it('keeps connection documents encrypted', async () => {
    const response = await put(admin, 'connection_documents', update({ encryptionAtRest: false }));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ENCRYPTION_LOCKED');
  });

  it.each([
    ['a fallback equal to the primary', { fallbackStorage: 'db' }],
    ['an unknown storage', { primaryStorage: 'nfs' }],
    ['a chunk size above 32 MiB', { chunkSize: 64 * MiB }],
    ['more than 6 parallel parts', { maxParallel: 7 }],
  ])('rejects %s', async (_label, overrides) => {
    const response = await put(admin, 'fault_records', update(overrides));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('lets only roles with edit_policies change a policy', async () => {
    const password = await createUser('maria', 'dispecerat');
    const cookie = await loginCookie(app, 'maria', password);

    const read = await request(app.getHttpServer()).get('/api/v1/policies').set(browser(cookie));
    const write = await put(cookie, 'fault_records', update());

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });

  it('answers 422 for an unknown category', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/policies/selfies')
      .set(browser(admin));

    expect(response.status).toBe(422);
  });
});
