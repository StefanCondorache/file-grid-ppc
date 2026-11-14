import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { scenario } from '../scenario';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'policies'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => db.reset());

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'filegrid' };
const MiB = 1024 * 1024;

const update = (extra: Record<string, unknown> = {}) => ({
  baseVersion: 3, primaryStorage: 'ftp', fallbackStorage: 's3', encryptionAtRest: false, chunkSize: 8 * MiB,
  maxParallel: 2, maxFileSize: 50 * MiB, allowedTypes: ['application/pdf'], retentionDays: 365, ...extra,
});
const put = (category: string, body: unknown) => fetch(url(`/policies/${category}`), { method: 'PUT', headers, body: JSON.stringify(body) });

describe('policies mock', () => {
  it('lists the four categories with the backend ids', async () => {
    await login('auditor');
    const body = (await (await fetch(url('/policies'))).json()) as { data: { category: string; primaryStorage: string }[] };
    expect(body.data.map((p) => p.category).sort()).toEqual(['connection_documents', 'drone_videos', 'fault_records', 'meter_readings']);
    expect(body.data.find((p) => p.category === 'fault_records')?.primaryStorage).toBe('s3');
  });

  it('saves a new version, writes it to the db, records history and emits policy.updated', async () => {
    await login('admin');
    const seen: unknown[] = [];
    const off = scenario.on((e) => seen.push(e));
    const res = await put('fault_records', update());
    off();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ category: 'fault_records', version: 4, primaryStorage: 'ftp' });
    expect(db.policies.get('fault')).toMatchObject({ version: 4, primaryStorage: 'FTP' });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'policy.updated', data: { category: 'fault_records', version: 4 } }));
    const history = (await (await fetch(url('/policies/fault_records/versions'))).json()) as { data: { version: number; changes: { field: string }[] }[] };
    expect(history.data[0]).toMatchObject({ version: 4 });
    expect(history.data[0]!.changes.map((c) => c.field)).toContain('primaryStorage');
  });

  it('answers a stale baseVersion with 409 and the current policy', async () => {
    await login('admin');
    const res = await put('fault_records', update({ baseVersion: 2 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'POLICY_VERSION_CONFLICT', currentPolicy: { version: 3, primaryStorage: 's3' } });
  });

  it('refuses non-admins, unencrypting connection documents and fallback = primary', async () => {
    await login('auditor');
    expect((await put('fault_records', update())).status).toBe(403);
    await login('admin');
    const locked = await put('connection_documents', update({ baseVersion: 2, encryptionAtRest: false }));
    expect(locked.status).toBe(422);
    expect(await locked.json()).toMatchObject({ code: 'ENCRYPTION_LOCKED' });
    const same = await put('fault_records', update({ fallbackStorage: 'ftp' }));
    expect(same.status).toBe(422);
    expect(await same.json()).toMatchObject({ code: 'VALIDATION_ERROR', fieldErrors: [expect.objectContaining({ field: 'fallbackStorage' })] });
  });
});
