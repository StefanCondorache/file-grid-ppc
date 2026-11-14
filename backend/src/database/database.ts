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
  // pg-pool listens for errors only on idle clients; a connection that dies while checked out (DB
  // restart mid-query) would otherwise crash the process. The query itself still rejects.
  pool.on('connect', (client) =>
    client.on('error', (error) =>
      logger?.warn({ err: error }, 'database connection failed while in use'),
    ),
  );
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
