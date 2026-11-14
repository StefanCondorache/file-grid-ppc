import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { ensureSeedUsers } from '../src/auth/user-seeder';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, type AppConfig, loadConfig } from '../src/config/config';
import type { Database } from '../src/database/schema';
import { ROOT_LOGGER, createRootLogger } from '../src/observability/logger';
import { STORAGE_NAMES, type StorageName } from '../src/storage/base';
import { MemoryStorage } from '../src/storage/memory';
import { StorageRegistry } from '../src/storage/registry';
import { STORAGE_REGISTRY } from '../src/storage/storage.module';
import {
  SEED_POLICIES_SQL,
  SEED_POLICY_VERSIONS_SQL,
} from '../src/database/migrations/0001_initial';
import {
  CSRF_HEADER,
  TEST_ADMIN_PASSWORD,
  TEST_JWT_SECRET,
  TEST_KEK,
  TEST_METER_KEY,
} from './constants';

const DATA_TABLES = [
  'operations',
  'audit_log',
  'meter_readings',
  'meter_batches',
  'upload_parts',
  'upload_sessions',
  'files',
  'policy_versions',
  'users',
];

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (test/global-setup.ts sets it)');
  return url;
}

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    FILEGRID_PG_DSN: testDatabaseUrl(),
    JWT_SECRET: TEST_JWT_SECRET,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    METER_API_KEY: TEST_METER_KEY,
    FILEGRID_KEK: TEST_KEK,
    FILEGRID_KEK_ID: 'k1',
    FILEGRID_STORAGE_DRIVER: 'memory',
    LOG_LEVEL: 'warn',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}

export function testDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: testDatabaseUrl(), max: 2 }),
    }),
  });
}

/** Empty every data table and put the seed policies back. */
export async function resetDatabase(): Promise<void> {
  const db = testDb();
  try {
    await db.transaction().execute(async (trx) => {
      await sql.raw(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`).execute(trx);
      await trx.deleteFrom('policies').execute();
      await sql.raw(SEED_POLICIES_SQL).execute(trx);
      await sql.raw(SEED_POLICY_VERSIONS_SQL).execute(trx);
    });
    // The app seeds the admin at start; tests that keep one app across resets need it back.
    await ensureSeedUsers(db, testConfig());
  } finally {
    await db.destroy();
  }
}

export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  extraModules?: Type[];
  logDestination?: DestinationStream;
  /** Storages for the app; default: fresh in-memory ones (no S3/FTP needed in tests). */
  storage?: StorageRegistry;
}

/** Three in-memory storages behind the real resilience layer, with test hooks. */
export function memoryStorages() {
  const adapters = STORAGE_NAMES.map((name) => new MemoryStorage(name));
  const registry = StorageRegistry.fromAdapters(adapters);
  return {
    registry,
    adapter: (name: StorageName): MemoryStorage => adapters[STORAGE_NAMES.indexOf(name)],
    /**
     * Empty every storage, make it healthy, close the breakers again and re-probe, so no storage
     * is still remembered as down by the health monitor (writes would skip it).
     */
    reset: async (): Promise<void> => {
      for (const adapter of adapters) adapter.clear();
      for (const name of STORAGE_NAMES) registry.get(name).breaker.recordSuccess(true);
      await registry.monitor.checkOnce();
    },
  };
}

/** Collects a binary response body into a Buffer (supertest only buffers text and JSON). */
export function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const config = testConfig(options.env);
  const logger = options.logDestination
    ? createRootLogger('info', options.logDestination)
    : createRootLogger(config.logLevel);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.extraModules ?? [])],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(ROOT_LOGGER)
    .useValue(logger)
    .overrideProvider(STORAGE_REGISTRY)
    .useValue(options.storage ?? memoryStorages().registry)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The session cookie set by a response (`name=value`), for the next request's Cookie header. */
export function sessionCookieFrom(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const session = cookies.find((cookie) => /^(__Host-)?fg_session=[^;]+/.test(cookie));
  if (!session) throw new Error('no session cookie in the response');
  return session.split(';')[0];
}

export function tokenFromCookie(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

/** Headers of a browser request with this session: the cookie and the CSRF header. */
export function browser(cookie: string): Record<string, string> {
  return { Cookie: cookie, ...CSRF_HEADER };
}

export function login(
  app: NestExpressApplication,
  username = 'admin',
  password = TEST_ADMIN_PASSWORD,
): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set(CSRF_HEADER)
    .send({ username, password });
}

/** Logs in and returns the session cookie (`__Host-fg_session=...`). */
export async function loginCookie(
  app: NestExpressApplication,
  username = 'admin',
  password = TEST_ADMIN_PASSWORD,
): Promise<string> {
  const response = await login(app, username, password);
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return sessionCookieFrom(response);
}

/** Logs in and returns the bare session token, for bearer-authenticated requests. */
export async function loginToken(
  app: NestExpressApplication,
  username = 'admin',
  password = TEST_ADMIN_PASSWORD,
): Promise<string> {
  return tokenFromCookie(await loginCookie(app, username, password));
}

/** Inserts a user with the given role straight into the database (only the admin is seeded). */
export async function createUser(
  username: string,
  role: 'teren' | 'dispecerat' | 'racordari' | 'auditor' | 'admin',
  password = `${username}-password-1`,
): Promise<string> {
  const db = testDb();
  try {
    await db
      .insertInto('users')
      .values({
        username,
        display_name: username,
        password_hash: await hashPassword(password),
        role,
      })
      .execute();
    return password;
  } finally {
    await db.destroy();
  }
}
