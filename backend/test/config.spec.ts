import { loadConfig } from '../src/config/config';
import { TEST_JWT_SECRET, TEST_METER_KEY } from './constants';

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
  JWT_SECRET: TEST_JWT_SECRET,
  ADMIN_PASSWORD: 'admin-password-1',
  METER_API_KEYS: TEST_METER_KEY,
};

describe('loadConfig', () => {
  it('rejects a JWT secret shorter than 32 characters without echoing it', () => {
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'tiny-secret' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'tiny-secret' })).not.toThrow(/tiny-secret/);
  });

  it('parses comma-separated meter API keys', () => {
    const config = loadConfig({
      ...BASE,
      METER_API_KEYS: 'first-key-0123456789, second-key-0123456789',
    });

    expect(config.meterApiKeys).toEqual(['first-key-0123456789', 'second-key-0123456789']);
  });

  it.each(['', 'short'])('rejects missing or short meter API keys (%p)', (keys) => {
    expect(() => loadConfig({ ...BASE, METER_API_KEYS: keys })).toThrow(/METER_API_KEYS/);
  });

  it('requires an admin password', () => {
    const env = { ...BASE };
    delete env.ADMIN_PASSWORD;

    expect(() => loadConfig(env)).toThrow(/ADMIN_PASSWORD/);
  });

  it('parses CORS origins and applies the documented defaults', () => {
    const config = loadConfig({
      ...BASE,
      CORS_ORIGINS: 'http://localhost:5173, https://ppc.filegrid.cc.cd',
    });

    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://ppc.filegrid.cc.cd']);
    expect(config.port).toBe(8000);
    expect(config.jwtTtlMinutes).toBe(480);
    expect(config.adminUsername).toBe('admin');
    expect(config.operatorPassword).toBeUndefined();
  });
});
