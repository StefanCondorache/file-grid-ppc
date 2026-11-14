import { loadConfig } from '../src/config/config';
import { TEST_JWT_SECRET, TEST_METER_KEY } from './constants';

const BASE: NodeJS.ProcessEnv = {
  POSTGRES_USER: 'filegrid',
  POSTGRES_PASSWORD: 'p@ss:word/1',
  POSTGRES_DB: 'filegrid',
  JWT_SECRET: TEST_JWT_SECRET,
  ADMIN_PASSWORD: 'admin-password-1',
  METER_API_KEY: TEST_METER_KEY,
};

describe('loadConfig', () => {
  it('reads the variables of the k3s Secrets with the documented defaults', () => {
    const config = loadConfig(BASE);

    expect(config.port).toBe(8000);
    expect(config.databaseUrl).toBe(
      'postgresql://filegrid:p%40ss%3Aword%2F1@127.0.0.1:5432/filegrid',
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
    ).toBe('postgresql://filegrid:p%40ss%3Aword%2F1@postgres.filegrid-storage.svc:6543/filegrid');
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
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'tiny-secret' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'tiny-secret' })).not.toThrow(/tiny-secret/);
  });

  it.each(['', 'short'])('rejects a missing or short meter API key (%p)', (key) => {
    expect(() => loadConfig({ ...BASE, METER_API_KEY: key })).toThrow(/METER_API_KEY/);
  });

  it('requires an admin password', () => {
    const env = { ...BASE };
    delete env.ADMIN_PASSWORD;

    expect(() => loadConfig(env)).toThrow(/ADMIN_PASSWORD/);
  });

  it('parses boolean switches', () => {
    const config = loadConfig({ ...BASE, FILEGRID_DEMO_MODE: 'false', COOKIE_SECURE: '0' });

    expect([config.demoMode, config.cookieSecure]).toEqual([false, false]);
  });
});
