import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import type { ApiError } from '@/lib/api/errors';
import type { Me } from '@/lib/api/types';
import { db } from '../db';
import { buildHandlers } from './index';
import { SEED_PASSWORD } from '../seed/auth';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'demo']))); server.listen({ onUnhandledRequest: 'error' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

const login = (username: string, password = SEED_PASSWORD) => unwrap(api.POST('/auth/login', { body: { username, password } }));

describe('auth mocks', () => {
  it('rejects a wrong password with INVALID_CREDENTIALS and no field hint', async () => {
    const e = await login('auditor', 'wrong').catch((x: ApiError) => x);
    expect([(e as ApiError).status, (e as ApiError).code, (e as ApiError).fieldErrors]).toEqual([401, 'INVALID_CREDENTIALS', []]);
  });

  it('me returns capabilities for the role', async () => {
    await login('racordari');
    let me = await unwrap(api.GET('/auth/me'));
    expect(me.capabilities).toContain('view_connection');
    expect(me.capabilities).not.toContain('reveal_pii');
    await login('auditor');
    me = await unwrap(api.GET('/auth/me'));
    expect(me.capabilities).toContain('reveal_pii');
    await login('admin');
    me = await unwrap(api.GET('/auth/me'));
    expect(me.capabilities).toContain('demo_controls');
    expect(me.capabilities).not.toContain('reveal_pii');
  });

  it('acting role switches activeRole but keeps realUser', async () => {
    await login('admin');
    const me: Me = await unwrap(api.POST('/demo/acting-role', { body: { role: 'auditor' } }));
    expect([me.activeRole, me.realUser.username]).toEqual(['auditor', 'admin']);
    expect(me.capabilities).toContain('reveal_pii');
  });

  it('every role switch appends a role_switch audit event', async () => {
    await login('admin');
    await unwrap(api.POST('/demo/acting-role', { body: { role: 'teren' } }));
    expect(db.list<{ action: string; actingAs: string }>('audit').filter((e) => e.action === 'role_switch')).toHaveLength(1);
  });

  it('a non-admin cannot switch roles', async () => {
    await login('teren');
    const e = await unwrap(api.POST('/demo/acting-role', { body: { role: 'auditor' } })).catch((x: ApiError) => x);
    expect((e as ApiError).status).toBe(403);
  });
});
