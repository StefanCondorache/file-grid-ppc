import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CSRF_HEADER } from './constants';
import { browser, createTestApp, loginCookie, memoryStorages, resetDatabase } from './helpers';

const CLIENT = '203.0.113.7';
const OTHER_CLIENT = '198.51.100.23';

interface AuditRow {
  action: string;
  outcome: string;
  actor: { username: string };
  clientIp: string | null;
}

/**
 * Behind Traefik the TCP peer is the Traefik pod; the client is in X-Forwarded-For. The backend
 * believes that header only from TRUSTED_PROXY_CIDRS (default: the cluster's pod and service
 * CIDRs), so the login rate limiter and the audit trail see the real client, and a client
 * talking to the pod directly cannot pick its own IP.
 */
describe('client IP from X-Forwarded-For', () => {
  const failedLogin = (app: NestExpressApplication, forwardedFor: string, username = 'admin') =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set(CSRF_HEADER)
      .set('X-Forwarded-For', forwardedFor)
      .send({ username, password: 'definitely-not-the-password' });

  const auditOf = async (app: NestExpressApplication): Promise<AuditRow[]> => {
    const admin = await loginCookie(app);
    const response = await request(app.getHttpServer())
      .get('/api/v1/audit-events')
      .query({ action: 'login' })
      .set(browser(admin));
    expect(response.status).toBe(200);
    return response.body.data as AuditRow[];
  };

  describe('from a peer outside TRUSTED_PROXY_CIDRS (the default: cluster CIDRs only)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      await resetDatabase();
      app = await createTestApp({
        env: { LOGIN_MAX_FAILURES: '2' },
        storage: memoryStorages().registry,
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('ignores a forged X-Forwarded-For: the audit has the peer address', async () => {
      await failedLogin(app, CLIENT, 'ana');

      const [row] = (await auditOf(app)).filter((r) => r.actor.username === 'ana');
      expect(row).toMatchObject({ outcome: 'failure', clientIp: '127.0.0.1' });
    });

    it('cannot dodge the login rate limiter by changing X-Forwarded-For', async () => {
      await failedLogin(app, CLIENT, 'mihai');
      await failedLogin(app, CLIENT, 'mihai');

      const third = await failedLogin(app, OTHER_CLIENT, 'mihai');

      expect(third.status).toBe(429);
    });
  });

  describe('from a trusted proxy (TRUSTED_PROXY_CIDRS includes the peer)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      await resetDatabase();
      app = await createTestApp({
        env: { LOGIN_MAX_FAILURES: '2', TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128' },
        storage: memoryStorages().registry,
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('records the client from X-Forwarded-For in the audit trail', async () => {
      await failedLogin(app, CLIENT, 'ana');
      // A forged entry on the left is skipped: the proxy appended the address it saw.
      await failedLogin(app, `10.0.0.1, ${OTHER_CLIENT}`, 'ioana');

      const rows = await auditOf(app);
      expect(rows.find((r) => r.actor.username === 'ana')?.clientIp).toBe(CLIENT);
      expect(rows.find((r) => r.actor.username === 'ioana')?.clientIp).toBe(OTHER_CLIENT);
      expect(rows.find((r) => r.actor.username === 'admin')?.clientIp).toBe('127.0.0.1');
    });

    it('rate-limits each client separately', async () => {
      await failedLogin(app, CLIENT, 'mihai');
      await failedLogin(app, CLIENT, 'mihai');

      const blocked = await failedLogin(app, CLIENT, 'mihai');
      const otherClient = await failedLogin(app, OTHER_CLIENT, 'mihai');

      expect(blocked.status).toBe(429);
      expect(otherClient.status).toBe(401);
    });
  });
});
