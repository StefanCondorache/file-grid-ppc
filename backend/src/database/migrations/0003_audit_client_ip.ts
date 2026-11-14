import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/** The client IP of each audited request (X-Forwarded-For from a trusted proxy, else the peer). */
export const migration0003: Migration = {
  up: async (db: Kysely<unknown>) => {
    await sql`ALTER TABLE audit_log ADD COLUMN client_ip varchar(64)`.execute(db);
  },
  down: async (db: Kysely<unknown>) => {
    await sql`ALTER TABLE audit_log DROP COLUMN client_ip`.execute(db);
  },
};
