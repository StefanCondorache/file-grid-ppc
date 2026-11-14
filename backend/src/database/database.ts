import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config';
import type { Database } from './schema';

export const DB = Symbol('DB');
export type Db = Kysely<Database>;

export function createDatabase(config: AppConfig, logger?: Logger): Db {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
  });
  // An idle client can die (DB restart, network); without a listener that would crash the process.
  pool.on('error', (error) => logger?.warn({ err: error }, 'idle database connection failed'));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
