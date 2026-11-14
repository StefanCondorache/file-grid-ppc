import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, type AppConfig, loadConfig } from '../src/config/config';
import type { Database } from '../src/database/schema';
import { ROOT_LOGGER, createRootLogger } from '../src/observability/logger';
import {
  SEED_POLICIES,
  TEST_ADMIN_PASSWORD,
  TEST_JWT_SECRET,
  TEST_METER_KEY,
  TEST_OPERATOR_PASSWORD,
} from './constants';

const DATA_TABLES = [
  'audit_log',
  'meter_readings',
  'upload_chunks',
  'upload_sessions',
  'files',
  'users',
];

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (test/global-setup.ts sets it)');
  return url;
}

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: testDatabaseUrl(),
    JWT_SECRET: TEST_JWT_SECRET,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    OPERATOR_PASSWORD: TEST_OPERATOR_PASSWORD,
    METER_API_KEYS: TEST_METER_KEY,
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
      await trx
        .insertInto('policies')
        .values(
          SEED_POLICIES.map(([category, primary, fallback, encrypted, chunk, concurrency]) => ({
            category,
            primary_storage: primary,
            fallback_storage: fallback,
            encrypted,
            chunk_size_bytes: chunk,
            max_concurrency: concurrency,
          })),
        )
        .execute();
    });
  } finally {
    await db.destroy();
  }
}

export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  extraModules?: Type[];
  logDestination?: DestinationStream;
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
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function loginToken(
  app: NestExpressApplication,
  username = 'admin',
  password = TEST_ADMIN_PASSWORD,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ username, password });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return String(response.body.access_token);
}
