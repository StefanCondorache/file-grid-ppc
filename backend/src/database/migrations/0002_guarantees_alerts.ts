import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Guarantee alerts (GET /alerts): one row per incident, raised when a category's guarantee leaves
 * `ok` and resolved when it is back. At most one open alert per category (partial unique index),
 * even if two replicas evaluated at once. Also counts resumed uploads (drone guarantee) and indexes
 * the operations log for the per-category guarantee and matrix queries.
 */

const CATEGORIES = "'meter_readings', 'fault_records', 'connection_documents', 'drone_videos'";

const UP = [
  `CREATE TABLE alerts (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     category varchar(32) NOT NULL,
     state varchar(16) NOT NULL,
     cause_code varchar(64) NOT NULL,
     cause_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
     raised_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     resolved_at timestamptz,
     acknowledged_at timestamptz,
     acknowledged_by varchar(64),
     trace_id varchar(64),
     CONSTRAINT pk_alerts PRIMARY KEY (id),
     CONSTRAINT ck_alerts_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_alerts_state CHECK (state IN ('at_risk', 'violated', 'resolved')),
     CONSTRAINT ck_alerts_resolved CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
   )`,
  "CREATE UNIQUE INDEX uq_alerts_open_category ON alerts (category) WHERE state <> 'resolved'",
  'CREATE INDEX ix_alerts_raised_at ON alerts (raised_at DESC)',
  'ALTER TABLE upload_sessions ADD COLUMN resume_count integer NOT NULL DEFAULT 0',
  'CREATE INDEX ix_operations_category_started_at ON operations (category, started_at DESC)',
];

const DOWN = [
  'DROP INDEX ix_operations_category_started_at',
  'ALTER TABLE upload_sessions DROP COLUMN resume_count',
  'DROP TABLE alerts',
];

async function runAll(db: Kysely<unknown>, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}

export const migration0002: Migration = {
  up: (db) => runAll(db, UP),
  down: (db) => runAll(db, DOWN),
};
