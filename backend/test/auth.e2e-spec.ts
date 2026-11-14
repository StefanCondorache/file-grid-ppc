import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { CSRF_HEADER, TEST_ADMIN_PASSWORD, TEST_JWT_SECRET, TEST_METER_KEY } from './constants';
import {
  bearer,
  browser,
  createTestApp,
  createUser,
  login,
  loginCookie,
  loginToken,
  resetDatabase,
  sessionCookieFrom,
  testDb,
} from './helpers';
import { TestOnlyModule } from './test-only.module';

const EIGHT_HOURS_S = 480 * 60;
const nowS = (): number => Math.floor(Date.now() / 1000);

/** A token built by hand (not by the app), valid unless an override breaks it. */
function craftToken(overrides: Record<string, unknown> = {}, secret = TEST_JWT_SECRET): string {
  const claims: Record<string, unknown> = {
    sub: 'admin',
    uid: '00000000-0000-0000-0000-000000000001',
    name: 'Administrator',
    role: 'admin',
    idle: nowS() + 600,
    iss: 'filegrid',
    aud: 'filegrid-api',
    iat: nowS(),
    exp: nowS() + 600,
    ...overrides,
  };
  const present = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));
  return jwt.sign(present, secret, { algorithm: 'HS256' });
}

function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { sub: 'admin', uid: 'x', name: 'x', role: 'admin', idle: nowS() + 600 };
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ ...payload, iss: 'filegrid', aud: 'filegrid-api', iat: nowS(), exp: nowS() + 600 })}.`;
}

describe('auth', () => {
  let app: NestExpressApplication;
  const me = (headers: Record<string, string>) =>
    request(app.getHttpServer()).get('/api/v1/auth/me').set(headers);

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp({ extraModules: [TestOnlyModule] });
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs the admin in with an 8 h HttpOnly, Secure, SameSite=Strict session cookie', async () => {
    const response = await login(app);

    expect(response.status).toBe(200);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(
      /^__Host-fg_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
    );
    expect(Number(/Max-Age=(\d+)/.exec(cookie)?.[1])).toBeGreaterThan(EIGHT_HOURS_S - 5);
    expect(response.body).toMatchObject({
      user: { username: 'admin', role: 'admin', displayName: 'Administrator' },
      realUser: { username: 'admin', role: 'admin' },
      activeRole: 'admin',
      demoMode: true,
      actingRoleExpiresAt: null,
    });
    expect(response.body.capabilities).toContain('edit_policies');
    expect(response.body.capabilities).not.toContain('reveal_pii');
    expect(response.body.roles).toEqual(['teren', 'dispecerat', 'racordari', 'auditor', 'admin']);
    const absolute = Date.parse(response.body.expiresAt) - Date.now();
    const idle = Date.parse(response.body.idleExpiresAt) - Date.now();
    expect(absolute).toBeGreaterThan((EIGHT_HOURS_S - 60) * 1000);
    expect(idle).toBeGreaterThan(29 * 60_000);
    expect(idle).toBeLessThanOrEqual(30 * 60_000);
  });

  it('answers /auth/me from the cookie', async () => {
    const cookie = await loginCookie(app);

    const response = await me({ Cookie: cookie });

    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe('admin');
  });

  it('also accepts the session token as a bearer header', async () => {
    const response = await me(bearer(await loginToken(app)));

    expect(response.status).toBe(200);
  });

  it('answers a wrong password and an unknown user identically', async () => {
    const wrongPassword = await login(app, 'admin', 'not-the-password');
    const unknownUser = await login(app, 'ghost', 'whatever-123');

    expect([wrongPassword.status, unknownUser.status]).toEqual([401, 401]);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.body).toEqual({ ...wrongPassword.body, traceId: unknownUser.body.traceId });
  });

  it('rejects a login body without a password with field errors', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set(CSRF_HEADER)
      .send({ username: 'admin' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.fieldErrors).toEqual([expect.objectContaining({ field: 'password' })]);
  });

  it('requires a session on /auth/me', async () => {
    const response = await me({});

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['expired', () => craftToken({ iat: nowS() - 900, exp: nowS() - 60 })],
    ['wrong audience', () => craftToken({ aud: 'someone-else' })],
    ['wrong issuer', () => craftToken({ iss: 'evil' })],
    ['wrong secret', () => craftToken({}, 'another-secret-0123456789-0123456789')],
    ['unknown role', () => craftToken({ role: 'superuser' })],
    ['missing exp', () => craftToken({ exp: undefined })],
    ['missing idle', () => craftToken({ idle: undefined })],
    ['alg none', () => unsignedToken()],
    ['garbage', () => 'not-a-jwt'],
  ])('rejects a session token that is %s', async (_label, makeToken) => {
    const response = await me({ Cookie: `__Host-fg_session=${makeToken()}` });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('ends a cookie session that was idle past its idle expiry', async () => {
    const response = await me({ Cookie: `__Host-fg_session=${craftToken({ idle: nowS() - 1 })}` });

    expect(response.status).toBe(401);
  });

  it('slides the idle window forward on use', async () => {
    const stale = craftToken({ idle: nowS() + 300, exp: nowS() + 3600 });

    const response = await me({ Cookie: `__Host-fg_session=${stale}` });

    expect(response.status).toBe(200);
    expect(sessionCookieFrom(response)).not.toBe(`__Host-fg_session=${stale}`);
    expect(Date.parse(response.body.idleExpiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  describe('CSRF', () => {
    it('rejects a state-changing request without X-Requested-With', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: TEST_ADMIN_PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_REJECTED');
      expect(response.headers['x-trace-id']).toBeDefined();
    });

    it('rejects a foreign Origin even with the header', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set({ ...browser(await loginCookie(app)), Origin: 'https://evil.example' });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_REJECTED');
    });

    it('rejects a cross-site fetch', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set({ ...browser(await loginCookie(app)), 'Sec-Fetch-Site': 'cross-site' });

      expect(response.status).toBe(403);
    });

    it('lets bearer-authenticated requests through without the header', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(bearer(await loginToken(app)));

      expect(response.status).toBe(204);
    });
  });

  it('logs out by expiring the cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set(browser(await loginCookie(app)));

    expect(response.status).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/^__Host-fg_session=; .*Max-Age=0/);
  });

  it('re-syncs the admin password from the environment on start', async () => {
    await app.close();
    const first = await createTestApp({ env: { ADMIN_PASSWORD: 'first-password-123' } });
    expect((await login(first, 'admin', 'first-password-123')).status).toBe(200);
    await first.close();

    app = await createTestApp({ env: { ADMIN_PASSWORD: 'second-password-456' } });

    expect((await login(app, 'admin', 'second-password-456')).status).toBe(200);
    expect((await login(app, 'admin', 'first-password-123')).status).toBe(401);
  });

  it('blocks a username after 10 failed logins, even with the right password', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(app, 'admin', 'wrong-guess')).status).toBe(401);
    }

    const blocked = await login(app, 'admin', 'wrong-guess');
    const stillBlocked = await login(app);

    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(stillBlocked.status).toBe(429);
  });

  it('enforces capabilities by role', async () => {
    const password = await createUser('ana', 'teren');
    const asTeren = await request(app.getHttpServer())
      .get('/api/v1/test-only/policies-admin')
      .set(browser(await loginCookie(app, 'ana', password)));
    const asAdmin = await request(app.getHttpServer())
      .get('/api/v1/test-only/policies-admin')
      .set(browser(await loginCookie(app)));

    expect(asTeren.status).toBe(403);
    expect(asTeren.body.code).toBe('FORBIDDEN');
    expect(asAdmin.status).toBe(200);
  });

  describe('demo role switcher', () => {
    const switchRole = (cookie: string, role: string) =>
      request(app.getHttpServer())
        .post('/api/v1/demo/acting-role')
        .set(browser(cookie))
        .send({ role });

    it('lets the admin act as the auditor, then back', async () => {
      const cookie = await loginCookie(app);

      const switched = await switchRole(cookie, 'auditor');
      const acting = sessionCookieFrom(switched);
      const adminRoute = await request(app.getHttpServer())
        .get('/api/v1/test-only/policies-admin')
        .set(browser(acting));
      const back = await request(app.getHttpServer())
        .delete('/api/v1/demo/acting-role')
        .set(browser(acting));

      expect(switched.status).toBe(200);
      expect(switched.body).toMatchObject({
        activeRole: 'auditor',
        user: { role: 'auditor' },
        realUser: { role: 'admin' },
      });
      expect(switched.body.capabilities).toContain('reveal_pii');
      expect(switched.body.actingRoleExpiresAt).not.toBeNull();
      expect(adminRoute.status).toBe(403);
      expect(back.body.activeRole).toBe('admin');
    });

    it('refuses a non-admin', async () => {
      const password = await createUser('ion', 'auditor');

      const response = await switchRole(await loginCookie(app, 'ion', password), 'admin');

      expect(response.status).toBe(403);
    });

    it('does not exist when demo mode is off', async () => {
      await app.close();
      app = await createTestApp({ env: { FILEGRID_DEMO_MODE: 'false' } });

      const response = await switchRole(await loginCookie(app), 'auditor');

      expect(response.status).toBe(404);
    });
  });

  describe('demo accounts (one per role, for the role dropdown on the login page)', () => {
    it.each([
      ['teren', 'Echipă de teren'],
      ['dispecerat', 'Dispecerat'],
      ['racordari', 'Angajat racordări'],
      ['auditor', 'Auditor'],
    ])('seeds %s with the demo password', async (role, displayName) => {
      const response = await login(app, role, TEST_ADMIN_PASSWORD);

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({ username: role, role, displayName });
    });

    it('uses DEMO_USERS_PASSWORD when it is set', async () => {
      await app.close();
      app = await createTestApp({ env: { DEMO_USERS_PASSWORD: 'demo-only-password-9' } });

      expect((await login(app, 'auditor', 'demo-only-password-9')).status).toBe(200);
      expect((await login(app, 'auditor', TEST_ADMIN_PASSWORD)).status).toBe(401);
    });

    it('does not create them when demo mode is off', async () => {
      await app.close();
      await resetDatabase();
      app = await createTestApp({ env: { FILEGRID_DEMO_MODE: 'false' } });

      expect((await login(app, 'auditor', TEST_ADMIN_PASSWORD)).status).toBe(401);
    });
  });

  it('accepts only the configured meter API key', async () => {
    const server = app.getHttpServer();
    const valid = await request(server)
      .get('/api/v1/test-only/meter')
      .set('X-API-Key', TEST_METER_KEY);
    const invalid = await request(server)
      .get('/api/v1/test-only/meter')
      .set('X-API-Key', 'guessed-key-000000');
    const missing = await request(server).get('/api/v1/test-only/meter');

    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({
      keyId: createHash('sha256').update(TEST_METER_KEY).digest('hex').slice(0, 8),
    });
    expect([invalid.status, missing.status]).toEqual([401, 401]);
    expect(invalid.body.code).toBe('INVALID_API_KEY');
  });

  it('writes every login and role switch to the audit log with its trace id', async () => {
    await login(app).set('X-Trace-Id', 'trace-login-ok');
    await login(app, 'admin', 'wrong-guess');

    const db = testDb();
    try {
      const rows = await db
        .selectFrom('audit_log')
        .select(['actor', 'action', 'outcome', 'trace_id'])
        .orderBy('id')
        .execute();
      expect(rows.map(({ actor, action, outcome }) => [actor, action, outcome])).toEqual([
        ['admin', 'login', 'success'],
        ['admin', 'login', 'failure'],
      ]);
      expect(rows[0].trace_id).toBe('trace-login-ok');
    } finally {
      await db.destroy();
    }
  });

  it('never returns a password hash', async () => {
    const response = await login(app);
    const profile = await me({ Cookie: sessionCookieFrom(response) });

    expect(response.text).not.toContain('argon2');
    expect(profile.text).not.toContain('argon2');
  });
});
