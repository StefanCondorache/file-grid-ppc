import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  TEST_ADMIN_PASSWORD,
  TEST_JWT_SECRET,
  TEST_METER_KEY,
  TEST_OPERATOR_PASSWORD,
} from './constants';
import { bearer, createTestApp, loginToken, resetDatabase, testDb } from './helpers';
import { TestOnlyModule } from './test-only.module';

const EIGHT_HOURS_S = 480 * 60;

function login(app: NestExpressApplication, username = 'admin', password = TEST_ADMIN_PASSWORD) {
  return request(app.getHttpServer()).post('/api/auth/login').send({ username, password });
}

/** A token built by hand (not by the app), valid unless an override breaks it. */
function craftToken(overrides: Record<string, unknown> = {}, secret = TEST_JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    sub: 'admin',
    role: 'admin',
    iss: 'filegrid',
    aud: 'filegrid-api',
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  const present = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));
  return jwt.sign(present, secret, { algorithm: 'HS256' });
}

function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'admin',
    role: 'admin',
    iss: 'filegrid',
    aud: 'filegrid-api',
    iat: now,
    exp: now + 600,
  };
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('auth', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp({ extraModules: [TestOnlyModule] });
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs the seeded admin in with an 8 h HS256 bearer token', async () => {
    const response = await login(app);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      token_type: 'bearer',
      expires_in: EIGHT_HOURS_S,
      user: { username: 'admin', role: 'admin' },
    });
    const claims = jwt.verify(response.body.access_token, TEST_JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'filegrid-api',
      issuer: 'filegrid',
    }) as jwt.JwtPayload;
    expect([claims.sub, claims.role]).toEqual(['admin', 'admin']);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(EIGHT_HOURS_S);
  });

  it('logs the seeded operator in with the operator role', async () => {
    const response = await login(app, 'operator', TEST_OPERATOR_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ username: 'operator', role: 'operator' });
  });

  it('answers a wrong password and an unknown user identically', async () => {
    const wrongPassword = await login(app, 'admin', 'not-the-password');
    const unknownUser = await login(app, 'ghost', 'whatever-123');

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('invalid_credentials');
    expect(unknownUser.body.error.code).toBe('invalid_credentials');
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('rejects a login body without a password', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'admin' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
  });

  it('requires a bearer token on /api/auth/me', async () => {
    const response = await request(app.getHttpServer()).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('returns the logged-in user from /api/auth/me', async () => {
    const token = await loginToken(app);

    const response = await request(app.getHttpServer()).get('/api/auth/me').set(bearer(token));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ username: 'admin', role: 'admin' });
  });

  it.each([
    [
      'expired',
      () =>
        craftToken({
          iat: Math.floor(Date.now() / 1000) - 900,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
    ],
    ['wrong audience', () => craftToken({ aud: 'someone-else' })],
    ['wrong issuer', () => craftToken({ iss: 'evil' })],
    ['wrong secret', () => craftToken({}, 'another-secret-0123456789-0123456789')],
    ['unknown role', () => craftToken({ role: 'superuser' })],
    ['missing exp', () => craftToken({ exp: undefined })],
    ['alg none', () => unsignedToken()],
    ['garbage', () => 'not-a-jwt'],
  ])('rejects a token that is %s', async (_label, makeToken) => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(bearer(makeToken()));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
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
    expect(blocked.body.error.code).toBe('too_many_attempts');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(stillBlocked.status).toBe(429);
  });

  it('forgets earlier failures after a successful login', async () => {
    for (let attempt = 0; attempt < 9; attempt += 1) await login(app, 'admin', 'wrong-guess');
    expect((await login(app)).status).toBe(200);

    for (let attempt = 0; attempt < 9; attempt += 1) await login(app, 'admin', 'wrong-guess');
    expect((await login(app)).status).toBe(200);
  });

  it('lets only admins through admin routes', async () => {
    const operator = await loginToken(app, 'operator', TEST_OPERATOR_PASSWORD);
    const admin = await loginToken(app);

    const asOperator = await request(app.getHttpServer())
      .get('/test-only/admin')
      .set(bearer(operator));
    const asAdmin = await request(app.getHttpServer()).get('/test-only/admin').set(bearer(admin));

    expect(asOperator.status).toBe(403);
    expect(asOperator.body.error.code).toBe('forbidden');
    expect(asAdmin.status).toBe(200);
  });

  it('accepts only configured meter API keys', async () => {
    const server = app.getHttpServer();
    const valid = await request(server).get('/test-only/meter').set('X-API-Key', TEST_METER_KEY);
    const invalid = await request(server)
      .get('/test-only/meter')
      .set('X-API-Key', 'guessed-key-000000');
    const missing = await request(server).get('/test-only/meter');

    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({
      key_id: createHash('sha256').update(TEST_METER_KEY).digest('hex').slice(0, 8),
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('invalid_api_key');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('invalid_api_key');
  });

  it('writes every login to the audit log with its trace id', async () => {
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
        ['admin', 'auth.login', 'success'],
        ['admin', 'auth.login', 'failure'],
      ]);
      expect(rows[0].trace_id).toBe('trace-login-ok');
    } finally {
      await db.destroy();
    }
  });

  it('never returns a password hash', async () => {
    const response = await login(app);
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(bearer(response.body.access_token));

    expect(response.text).not.toContain('argon2');
    expect(me.text).not.toContain('argon2');
  });
});
