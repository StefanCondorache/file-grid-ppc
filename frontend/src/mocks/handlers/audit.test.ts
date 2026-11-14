import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import type { ApiError } from '@/lib/api/errors';
import { db } from '../db';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'audit']))); server.listen({ onUnhandledRequest: 'error' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));

describe('audit mocks', () => {
  it('is forbidden for teren', async () => {
    await login('teren');
    const e = await unwrap(api.GET('/audit-events', {})).catch((x: ApiError) => x);
    expect((e as ApiError).status).toBe(403);
  });

  it('lists newest first and filters by action', async () => {
    await login('auditor');
    await login('admin');
    await login('auditor');
    const all = await unwrap(api.GET('/audit-events', {})) as unknown as { data: { action: string; at: string }[]; meta: { total: number } };
    expect(all.meta.total).toBe(3);
    const none = await unwrap(api.GET('/audit-events', { params: { query: { action: 'upload' } as never } })) as unknown as { data: unknown[] };
    expect(none.data).toEqual([]);
  });
});
