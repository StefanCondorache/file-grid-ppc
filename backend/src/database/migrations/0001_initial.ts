import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Metadata schema (schema public; the `db` storage keeps object bytes in schema blobstore):
 * users, policies (+ versions), files, upload sessions and parts, meter readings, audit log and
 * operations (one row per traced request, read back by GET /traces/{traceId}).
 */

const CATEGORIES = "'meter_readings', 'fault_records', 'connection_documents', 'drone_videos'";
const STORAGES = "'s3', 'ftp', 'db'";
const ZONES = "'muntenia', 'banat', 'dobrogea'";
const ORIGINS = "'manual', 'simulator', 'storm', 'seed'";
const ROLES = "'teren', 'dispecerat', 'racordari', 'auditor', 'admin'";
const SHA256_HEX = "'^[0-9a-f]{64}$'";
const MiB = 1024 * 1024;

/** The initial policy per category (also used by the tests to restore the seed). */
export const SEED_POLICIES_SQL = `INSERT INTO policies (category, primary_storage, fallback_storage, encrypted, chunk_size_bytes,
                         max_parallel, max_concurrency, max_file_size_bytes, allowed_types,
                         retention_days)
   VALUES
     ('meter_readings', 'db', 's3', false, ${MiB}, 1, 16, ${16 * MiB},
      '["application/x-ndjson"]', 365),
     ('fault_records', 's3', 'db', false, ${5 * MiB}, 4, 8, ${512 * MiB},
      '["application/pdf", "image/jpeg", "image/png", "text/plain", "text/csv", "application/json", "application/zip", "application/octet-stream"]',
      3650),
     ('connection_documents', 's3', 'db', true, ${5 * MiB}, 3, 4, ${50 * MiB},
      '["application/pdf", "image/jpeg", "image/png"]', 3650),
     ('drone_videos', 'ftp', 's3', false, ${16 * MiB}, 4, 4, ${4096 * MiB},
      '["video/mp4", "video/quicktime", "video/x-matroska", "application/octet-stream"]', 365)`;
export const SEED_POLICY_VERSIONS_SQL = `INSERT INTO policy_versions (category, version, snapshot, changed_by)
   SELECT category, version, to_jsonb(policies.*), 'system' FROM policies`;

const UP = [
  `CREATE TABLE users (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     username varchar(64) NOT NULL,
     display_name varchar(128) NOT NULL,
     password_hash text NOT NULL,
     role varchar(16) NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT pk_users PRIMARY KEY (id),
     CONSTRAINT uq_users_username UNIQUE (username),
     CONSTRAINT ck_users_role CHECK (role IN (${ROLES}))
   )`,
  `CREATE TABLE policies (
     category varchar(32) NOT NULL,
     version integer NOT NULL DEFAULT 1,
     primary_storage varchar(16) NOT NULL,
     fallback_storage varchar(16),
     encrypted boolean NOT NULL,
     chunk_size_bytes integer NOT NULL,
     max_parallel integer NOT NULL,
     max_concurrency integer NOT NULL,
     max_file_size_bytes bigint NOT NULL,
     allowed_types jsonb NOT NULL DEFAULT '[]'::jsonb,
     retention_days integer NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     updated_by varchar(64) NOT NULL DEFAULT 'system',
     CONSTRAINT pk_policies PRIMARY KEY (category),
     CONSTRAINT ck_policies_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_policies_primary_storage CHECK (primary_storage IN (${STORAGES})),
     CONSTRAINT ck_policies_fallback_storage
       CHECK (fallback_storage IS NULL OR fallback_storage IN (${STORAGES})),
     CONSTRAINT ck_policies_fallback_differs
       CHECK (fallback_storage IS NULL OR fallback_storage <> primary_storage),
     CONSTRAINT ck_policies_chunk_size CHECK (chunk_size_bytes BETWEEN ${MiB} AND ${32 * MiB}),
     CONSTRAINT ck_policies_max_parallel CHECK (max_parallel BETWEEN 1 AND 6),
     CONSTRAINT ck_policies_max_concurrency CHECK (max_concurrency BETWEEN 1 AND 256),
     CONSTRAINT ck_policies_max_file_size CHECK (max_file_size_bytes > 0),
     CONSTRAINT ck_policies_retention CHECK (retention_days >= 1),
     CONSTRAINT ck_policies_connection_encrypted
       CHECK (category <> 'connection_documents' OR encrypted)
   )`,
  `CREATE TABLE policy_versions (
     category varchar(32) NOT NULL,
     version integer NOT NULL,
     snapshot jsonb NOT NULL,
     changes jsonb NOT NULL DEFAULT '[]'::jsonb,
     changed_by varchar(64) NOT NULL,
     changed_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT pk_policy_versions PRIMARY KEY (category, version)
   )`,
  `CREATE TABLE files (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     category varchar(32) NOT NULL,
     display_name varchar(255) NOT NULL,
     mime_type varchar(255) NOT NULL,
     size_bytes bigint NOT NULL,
     sha256 varchar(64) NOT NULL,
     client_sha256 varchar(64),
     storage varchar(16) NOT NULL,
     storage_key varchar(512) NOT NULL,
     stored_size_bytes bigint NOT NULL,
     stored_sha256 varchar(64) NOT NULL,
     encrypted boolean NOT NULL,
     used_fallback boolean NOT NULL DEFAULT false,
     integrity varchar(16) NOT NULL,
     policy_version integer NOT NULL,
     zone varchar(16),
     origin varchar(16) NOT NULL DEFAULT 'manual',
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     pii_encrypted text,
     uploaded_by varchar(64),
     upload_trace_id varchar(64) NOT NULL,
     upload_started_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_verified_at timestamptz,
     corrupted_at timestamptz,
     CONSTRAINT pk_files PRIMARY KEY (id),
     CONSTRAINT uq_files_storage_storage_key UNIQUE (storage, storage_key),
     CONSTRAINT ck_files_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_files_storage CHECK (storage IN (${STORAGES})),
     CONSTRAINT ck_files_integrity
       CHECK (integrity IN ('verified', 'server_verified', 'unverified', 'corrupt')),
     CONSTRAINT ck_files_zone CHECK (zone IS NULL OR zone IN (${ZONES})),
     CONSTRAINT ck_files_origin CHECK (origin IN (${ORIGINS})),
     CONSTRAINT ck_files_sha256_hex CHECK (sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_files_stored_sha256_hex CHECK (stored_sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_files_sizes CHECK (size_bytes >= 0 AND stored_size_bytes >= 0)
   )`,
  'CREATE INDEX ix_files_category_created_at ON files (category, created_at DESC)',
  'CREATE INDEX ix_files_created_at ON files (created_at DESC)',
  `CREATE TABLE upload_sessions (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     idempotency_key varchar(64) NOT NULL,
     category varchar(32) NOT NULL,
     file_name varchar(255) NOT NULL,
     display_name varchar(255) NOT NULL,
     mime_type varchar(255) NOT NULL,
     file_size bigint NOT NULL,
     chunk_size integer NOT NULL,
     part_count integer NOT NULL,
     max_parallel integer NOT NULL,
     policy_version integer NOT NULL,
     encrypted boolean NOT NULL,
     primary_storage varchar(16) NOT NULL,
     fallback_storage varchar(16),
     zone varchar(16),
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     pii_encrypted text,
     status varchar(16) NOT NULL DEFAULT 'open',
     client_sha256 varchar(64),
     result jsonb,
     error jsonb,
     file_id uuid,
     created_by varchar(64) NOT NULL,
     started_as_role varchar(16) NOT NULL,
     trace_id varchar(64) NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     CONSTRAINT pk_upload_sessions PRIMARY KEY (id),
     CONSTRAINT uq_upload_sessions_created_by_idempotency_key UNIQUE (created_by, idempotency_key),
     CONSTRAINT fk_upload_sessions_file_id_files FOREIGN KEY (file_id) REFERENCES files (id),
     CONSTRAINT ck_upload_sessions_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_upload_sessions_primary_storage CHECK (primary_storage IN (${STORAGES})),
     CONSTRAINT ck_upload_sessions_status
       CHECK (status IN ('open', 'verifying', 'completed', 'failed', 'aborted', 'expired')),
     CONSTRAINT ck_upload_sessions_zone CHECK (zone IS NULL OR zone IN (${ZONES})),
     CONSTRAINT ck_upload_sessions_client_sha256_hex
       CHECK (client_sha256 IS NULL OR client_sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_upload_sessions_sizes
       CHECK (file_size > 0 AND part_count > 0 AND chunk_size > 0)
   )`,
  'CREATE INDEX ix_upload_sessions_status_expires_at ON upload_sessions (status, expires_at)',
  `CREATE TABLE upload_parts (
     upload_id uuid NOT NULL,
     part_number integer NOT NULL,
     size_bytes integer NOT NULL,
     sha256 varchar(64) NOT NULL,
     storage varchar(16) NOT NULL,
     storage_key varchar(512) NOT NULL,
     received_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT pk_upload_parts PRIMARY KEY (upload_id, part_number),
     CONSTRAINT fk_upload_parts_upload_id_upload_sessions
       FOREIGN KEY (upload_id) REFERENCES upload_sessions (id) ON DELETE CASCADE,
     CONSTRAINT ck_upload_parts_part_number CHECK (part_number >= 1),
     CONSTRAINT ck_upload_parts_size CHECK (size_bytes > 0),
     CONSTRAINT ck_upload_parts_sha256_hex CHECK (sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_upload_parts_storage CHECK (storage IN (${STORAGES}))
   )`,
  `CREATE TABLE meter_readings (
     reading_id varchar(80) NOT NULL,
     meter_id varchar(64) NOT NULL,
     zone varchar(16) NOT NULL,
     reading_time timestamptz NOT NULL,
     kwh numeric(12, 3) NOT NULL,
     sequence bigint NOT NULL,
     origin varchar(16) NOT NULL,
     file_id uuid NOT NULL,
     received_at timestamptz NOT NULL DEFAULT now(),
     trace_id varchar(64) NOT NULL,
     CONSTRAINT pk_meter_readings PRIMARY KEY (reading_id),
     CONSTRAINT fk_meter_readings_file_id_files FOREIGN KEY (file_id) REFERENCES files (id)
       DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT ck_meter_readings_zone CHECK (zone IN (${ZONES})),
     CONSTRAINT ck_meter_readings_origin CHECK (origin IN (${ORIGINS})),
     CONSTRAINT ck_meter_readings_kwh CHECK (kwh >= 0)
   )`,
  'CREATE INDEX ix_meter_readings_received_at ON meter_readings (received_at DESC)',
  'CREATE INDEX ix_meter_readings_zone_reading_time ON meter_readings (zone, reading_time)',
  'CREATE INDEX ix_meter_readings_file_id ON meter_readings (file_id)',
  `CREATE TABLE meter_batches (
     id bigserial NOT NULL,
     at timestamptz NOT NULL DEFAULT now(),
     received integer NOT NULL,
     stored integer NOT NULL,
     duplicates integer NOT NULL,
     origin varchar(16) NOT NULL,
     file_id uuid,
     trace_id varchar(64) NOT NULL,
     CONSTRAINT pk_meter_batches PRIMARY KEY (id)
   )`,
  'CREATE INDEX ix_meter_batches_at ON meter_batches (at DESC)',
  `CREATE TABLE audit_log (
     id bigserial NOT NULL,
     at timestamptz NOT NULL DEFAULT now(),
     actor varchar(64) NOT NULL,
     acting_as varchar(16),
     demo boolean NOT NULL DEFAULT false,
     action varchar(32) NOT NULL,
     outcome varchar(16) NOT NULL,
     category varchar(32),
     file_id uuid,
     reason varchar(500),
     details text,
     trace_id varchar(64),
     CONSTRAINT pk_audit_log PRIMARY KEY (id),
     CONSTRAINT ck_audit_log_outcome CHECK (outcome IN ('success', 'failure', 'denied'))
   )`,
  'CREATE INDEX ix_audit_log_at ON audit_log (at DESC)',
  'CREATE INDEX ix_audit_log_file_id ON audit_log (file_id)',
  'CREATE INDEX ix_audit_log_trace_id ON audit_log (trace_id)',
  `CREATE TABLE operations (
     id bigserial NOT NULL,
     trace_id varchar(64) NOT NULL,
     operation varchar(64) NOT NULL,
     category varchar(32),
     storage varchar(16),
     file_id uuid,
     status varchar(8) NOT NULL,
     started_at timestamptz NOT NULL,
     duration_ms double precision NOT NULL,
     size_bytes bigint,
     spans jsonb NOT NULL DEFAULT '[]'::jsonb,
     CONSTRAINT pk_operations PRIMARY KEY (id),
     CONSTRAINT ck_operations_status CHECK (status IN ('ok', 'error'))
   )`,
  'CREATE INDEX ix_operations_trace_id ON operations (trace_id)',
  'CREATE INDEX ix_operations_started_at ON operations (started_at DESC)',
  'CREATE INDEX ix_operations_file_id ON operations (file_id)',
  SEED_POLICIES_SQL,
  SEED_POLICY_VERSIONS_SQL,
];

const DOWN = [
  'DROP TABLE operations',
  'DROP TABLE audit_log',
  'DROP TABLE meter_batches',
  'DROP TABLE meter_readings',
  'DROP TABLE upload_parts',
  'DROP TABLE upload_sessions',
  'DROP TABLE files',
  'DROP TABLE policy_versions',
  'DROP TABLE policies',
  'DROP TABLE users',
];

async function runAll(db: Kysely<unknown>, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}

export const migration0001: Migration = {
  up: (db) => runAll(db, UP),
  down: (db) => runAll(db, DOWN),
};
