import { resolveDatabaseUrl } from '../config/config';
import { createRootLogger } from '../observability/logger';
import { migrateDatabaseUrl } from './migrator';

/**
 * Manual migration entry point: `node dist/database/migrate.js`. The server migrates by itself at
 * start (src/lifecycle/boot.service.ts); this is for running the migrations alone.
 */
async function main(): Promise<void> {
  const logger = createRootLogger(process.env.LOG_LEVEL ?? 'info');
  try {
    const applied = await migrateDatabaseUrl(resolveDatabaseUrl(process.env));
    logger.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema up to date');
  } catch (error) {
    logger.fatal({ err: error }, 'migration failed');
    process.exitCode = 1;
  }
}

void main();
