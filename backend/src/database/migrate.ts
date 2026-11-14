import { createRootLogger } from '../observability/logger';
import { migrateDatabaseUrl } from './migrator';

/** Container entry point run before the server: `node dist/database/migrate.js`. */
async function main(): Promise<void> {
  const logger = createRootLogger(process.env.LOG_LEVEL ?? 'info');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.fatal('DATABASE_URL is required to run migrations');
    process.exitCode = 1;
    return;
  }
  try {
    const applied = await migrateDatabaseUrl(databaseUrl);
    logger.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema up to date');
  } catch (error) {
    logger.fatal({ err: error }, 'migration failed');
    process.exitCode = 1;
  }
}

void main();
