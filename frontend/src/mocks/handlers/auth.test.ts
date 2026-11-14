import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import type { ApiError } from '@/lib/api/errors';
import type { Me } from '@/lib/api/types';
import { db } from '../db';
import { buildHandlers } from './index';
import { SEED_PASSWORD } from '../seed/auth';
import { setMockSettings } from '../session';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'demo']))); server.listen({ onUnhandledRequest: 'error' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());
afterEach(() => setMockSettings(null));

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

  it('login-options defaults to passwordless off, and then a password is required', async () => {
    expect(await unwrap(api.GET('/auth/login-options'))).toEqual({ passwordless: false });
    const e = await unwrap(api.POST('/auth/login', { body: { username: 'auditor' } })).catch((x: ApiError) => x);
    expect((e as ApiError).code).toBe('INVALID_CREDENTIALS');
  });

  describe('passwordless knob (fg.mock.passwordless, like FILEGRID_PASSWORDLESS_LOGIN)', () => {
    beforeEach(() => setMockSettings({ passwordless: true }));

    it('login-options says so and every role logs in without a password', async () => {
      expect(await unwrap(api.GET('/auth/login-options'))).toEqual({ passwordless: true });
      for (const username of ['teren', 'dispecerat', 'racordari', 'auditor', 'admin']) {
        const me = await unwrap(api.POST('/auth/login', { body: { username } }));
        expect(me.realUser.username).toBe(username);
      }
    });

    it('still rejects an unknown username and audits passwordless logins', async () => {
      const e = await unwrap(api.POST('/auth/login', { body: { username: 'ghost' } })).catch((x: ApiError) => x);
      expect([(e as ApiError).status, (e as ApiError).code]).toEqual([401, 'INVALID_CREDENTIALS']);
      await unwrap(api.POST('/auth/login', { body: { username: 'auditor' } }));
      expect(db.list<{ action: string; demo: boolean; details?: string }>('audit').filter((x) => x.action === 'login')).toEqual([
        expect.objectContaining({ demo: true, details: 'passwordless' }),
      ]);
    });

    it('is ignored when demo mode is off', async () => {
      setMockSettings({ passwordless: true, demoMode: false });
      expect(await unwrap(api.GET('/auth/login-options'))).toEqual({ passwordless: false });
      const e = await unwrap(api.POST('/auth/login', { body: { username: 'auditor' } })).catch((x: ApiError) => x);
      expect((e as ApiError).code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('a non-admin cannot switch roles', async () => {
    await login('teren');
    const e = await unwrap(api.POST('/demo/acting-role', { body: { role: 'auditor' } })).catch((x: ApiError) => x);
    expect((e as ApiError).status).toBe(403);
  });
});
