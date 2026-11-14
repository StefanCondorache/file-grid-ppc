import { loadConfig } from '../src/config/config';
import { TEST_JWT_SECRET, TEST_METER_KEY, fakeSecret } from './constants';

// URL-special characters on purpose: the DSN builder must encode them.
const PG_PASSWORD = `${fakeSecret(9)}@:/`;
const TINY_SECRET = fakeSecret(8);

const BASE: NodeJS.ProcessEnv = {
  POSTGRES_USER: 'filegrid',
  POSTGRES_PASSWORD: PG_PASSWORD,
  POSTGRES_DB: 'filegrid',
  JWT_SECRET: TEST_JWT_SECRET,
  ADMIN_PASSWORD: fakeSecret(),
  METER_API_KEY: TEST_METER_KEY,
};

describe('loadConfig', () => {
  it('reads the variables of the k3s Secrets with the documented defaults', () => {
    const config = loadConfig(BASE);

    expect(config.port).toBe(8000);
    expect(config.databaseUrl).toBe(
      `postgresql://filegrid:${encodeURIComponent(PG_PASSWORD)}@127.0.0.1:5432/filegrid`,
    );
    expect(config.sessionTtlMinutes).toBe(480);
    expect(config.sessionIdleMinutes).toBe(30);
    expect(config.adminUsername).toBe('admin');
    expect(config.cookieSecure).toBe(true);
    expect(config.demoMode).toBe(true);
  });

  it('builds the DSN from FILEGRID_PG_HOST/PORT, or takes FILEGRID_PG_DSN as is', () => {
    expect(
      loadConfig({
        ...BASE,
        FILEGRID_PG_HOST: 'postgres.filegrid-storage.svc',
        FILEGRID_PG_PORT: '6543',
      }).databaseUrl,
    ).toBe(
      `postgresql://filegrid:${encodeURIComponent(PG_PASSWORD)}@postgres.filegrid-storage.svc:6543/filegrid`,
    );
    expect(loadConfig({ ...BASE, FILEGRID_PG_DSN: 'postgresql://x:y@z/w' }).databaseUrl).toBe(
      'postgresql://x:y@z/w',
    );
  });

  it('names the missing database variables, never their values', () => {
    const env = { ...BASE };
    delete env.POSTGRES_PASSWORD;

    expect(() => loadConfig(env)).toThrow(/POSTGRES_PASSWORD/);
  });

  it('rejects a JWT secret shorter than 32 characters without echoing it', () => {
    expect(() => loadConfig({ ...BASE, JWT_SECRET: TINY_SECRET })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...BASE, JWT_SECRET: TINY_SECRET })).not.toThrow(TINY_SECRET);
  });

  it.each(['', 'short'])('rejects a missing or short meter API key (%p)', (key) => {
    expect(() => loadConfig({ ...BASE, METER_API_KEY: key })).toThrow(/METER_API_KEY/);
  });

  it('requires an admin password', () => {
    const env = { ...BASE };
    delete env.ADMIN_PASSWORD;

    expect(() => loadConfig(env)).toThrow(/ADMIN_PASSWORD/);
  });

  it('turns passwordless login on only together with demo mode', () => {
    const effective = (env: NodeJS.ProcessEnv) => {
      const config = loadConfig({ ...BASE, ...env });
      return [config.passwordlessLogin, config.passwordlessLoginRequested];
    };

    expect(effective({})).toEqual([false, false]);
    expect(effective({ FILEGRID_PASSWORDLESS_LOGIN: 'true' })).toEqual([true, true]);
    expect(effective({ FILEGRID_PASSWORDLESS_LOGIN: 'true', FILEGRID_DEMO_MODE: 'false' })).toEqual(
      [false, true],
    );
    expect(effective({ FILEGRID_PASSWORDLESS_LOGIN: 'false' })).toEqual([false, false]);
    expect(() => loadConfig({ ...BASE, FILEGRID_PASSWORDLESS_LOGIN: 'maybe' })).toThrow(
      /FILEGRID_PASSWORDLESS_LOGIN/,
    );
  });

  it('parses boolean switches', () => {
    const config = loadConfig({ ...BASE, FILEGRID_DEMO_MODE: 'false', COOKIE_SECURE: '0' });

    expect([config.demoMode, config.cookieSecure]).toEqual([false, false]);
  });
});
