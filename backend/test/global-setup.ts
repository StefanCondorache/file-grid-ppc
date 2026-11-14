import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { migrateDatabaseUrl } from '../src/database/migrator';

declare global {
  var __FILEGRID_TEST_PG__: EmbeddedPostgres | undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts one throwaway Postgres 17 (from the embedded-postgres npm package) for the whole
 * test run, unless TEST_DATABASE_URL points at an existing database. Either way it migrates.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.TEST_DATABASE_URL) {
    const port = await freePort();
    const postgres = new EmbeddedPostgres({
      databaseDir: join(__dirname, '..', `.pgdata-test-${process.pid}`),
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('filegrid_test');
    globalThis.__FILEGRID_TEST_PG__ = postgres;
    process.env.TEST_DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/filegrid_test`;
  }
  await migrateDatabaseUrl(process.env.TEST_DATABASE_URL);
}
