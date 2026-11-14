import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { buildHandlers } from '.';
import { SEED_PASSWORD } from '../seed/auth';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'policies']))); server.listen({ onUnhandledRequest: 'bypass' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'filegrid' };
const login = (u: string) => fetch(apiUrl('/auth/login'), { method: 'POST', headers: H, body: JSON.stringify({ username: u, password: SEED_PASSWORD }) });
const put = (body: Record<string, unknown>) => fetch(apiUrl('/policies/fault_records'), { method: 'PUT', headers: H, body: JSON.stringify(body) });
const body = (over: Record<string, unknown> = {}) => ({ baseVersion: 3, primaryStorage: 's3', fallbackStorage: 'db', encryptionAtRest: false, chunkSize: 8 * 1024 * 1024, maxParallel: 3, maxFileSize: 1000, allowedTypes: [], retentionDays: 30, ...over });

describe('policy mock', () => {
  it('bumps the version, writes the db and records history', async () => {
    await login('admin');
    const res = await put(body());
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(4);
    expect(db.policies.get('fault' as never)?.version).toBe(4);
    const hist = await (await fetch(apiUrl('/policies/fault_records/versions'))).json();
    expect(hist.data[0].version).toBe(4);
  });
  it('409 with currentPolicy on a stale baseVersion', async () => {
    await login('admin');
    const res = await put(body({ baseVersion: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).currentPolicy.version).toBe(3);
  });
  it('403 for a non-admin', async () => {
    await login('auditor');
    expect((await put(body())).status).toBe(403);
  });
});
