import { Kysely, PostgresDialect } from 'kysely';
import { type Migration, type MigrationResult, Migrator, NO_MIGRATIONS } from 'kysely/migration';
import { Pool } from 'pg';
import { migration0001 } from './migrations/0001_initial';
import { migration0002 } from './migrations/0002_guarantees_alerts';
import type { Database } from './schema';

/**
 * Kysely's Postgres adapter holds pg_advisory_lock while it migrates, so every replica can run
 * this at start: the first one migrates, the others wait and then find nothing left to do.
 */
const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_initial': migration0001,
  '0002_guarantees_alerts': migration0002,
};

function migratorFor(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => ({ ...MIGRATIONS }) } });
}

function failIfError(error: unknown): void {
  if (error === undefined) return;
  throw error instanceof Error ? error : new Error(`migration failed: ${JSON.stringify(error)}`);
}

function appliedNames(results: MigrationResult[] | undefined): string[] {
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const { error, results } = await migratorFor(db).migrateToLatest();
  failIfError(error);
  return appliedNames(results);
}

export async function migrateToNothing(db: Kysely<Database>): Promise<string[]> {
  const { error, results } = await migratorFor(db).migrateTo(NO_MIGRATIONS);
  failIfError(error);
  return appliedNames(results);
}

export async function migrateDatabaseUrl(databaseUrl: string): Promise<string[]> {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
  });
  try {
    return await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
