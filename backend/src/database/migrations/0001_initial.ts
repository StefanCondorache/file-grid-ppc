import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Metadata schema: users, policies, files, uploads, meter readings, audit log. */

const CATEGORIES = "'meter_reading', 'fault_record', 'connection_doc', 'drone_video'";
const STORAGES = "'s3', 'ftp', 'db'";
const REGIONS = "'muntenia', 'banat', 'dobrogea'";
const SHA256_HEX = "'^[0-9a-f]{64}$'";

const UP = [
  `CREATE TABLE users (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     username varchar(64) NOT NULL,
     password_hash text NOT NULL,
     role varchar(16) NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT pk_users PRIMARY KEY (id),
     CONSTRAINT uq_users_username UNIQUE (username),
     CONSTRAINT ck_users_role CHECK (role IN ('admin', 'operator'))
   )`,
  `CREATE TABLE policies (
     category varchar(32) NOT NULL,
     primary_storage varchar(16) NOT NULL,
     fallback_storage varchar(16),
     encrypted boolean NOT NULL,
     chunk_size_bytes integer NOT NULL,
     max_concurrency integer NOT NULL,
     version integer NOT NULL DEFAULT 1,
     updated_at timestamptz NOT NULL DEFAULT now(),
     updated_by varchar(64),
     CONSTRAINT pk_policies PRIMARY KEY (category),
     CONSTRAINT ck_policies_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_policies_primary_storage CHECK (primary_storage IN (${STORAGES})),
     CONSTRAINT ck_policies_fallback_storage
       CHECK (fallback_storage IS NULL OR fallback_storage IN (${STORAGES})),
     CONSTRAINT ck_policies_fallback_differs
       CHECK (fallback_storage IS NULL OR fallback_storage <> primary_storage),
     CONSTRAINT ck_policies_chunk_size CHECK (chunk_size_bytes BETWEEN 65536 AND 67108864),
     CONSTRAINT ck_policies_max_concurrency CHECK (max_concurrency BETWEEN 1 AND 256)
   )`,
  `CREATE TABLE files (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     category varchar(32) NOT NULL,
     original_name varchar(255) NOT NULL,
     content_type varchar(255) NOT NULL,
     size_bytes bigint NOT NULL,
     sha256 varchar(64) NOT NULL,
     storage varchar(16) NOT NULL,
     storage_key varchar(512) NOT NULL,
     stored_size_bytes bigint NOT NULL,
     stored_sha256 varchar(64) NOT NULL,
     encrypted boolean NOT NULL,
     status varchar(16) NOT NULL DEFAULT 'stored',
     region varchar(16),
     attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
     uploaded_by varchar(64) NOT NULL,
     trace_id varchar(64) NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_verified_at timestamptz,
     corrupted_at timestamptz,
     CONSTRAINT pk_files PRIMARY KEY (id),
     CONSTRAINT uq_files_storage_storage_key UNIQUE (storage, storage_key),
     CONSTRAINT ck_files_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_files_storage CHECK (storage IN (${STORAGES})),
     CONSTRAINT ck_files_status CHECK (status IN ('stored', 'corrupted')),
     CONSTRAINT ck_files_region CHECK (region IS NULL OR region IN (${REGIONS})),
     CONSTRAINT ck_files_sha256_hex CHECK (sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_files_stored_sha256_hex CHECK (stored_sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_files_sizes CHECK (size_bytes >= 0 AND stored_size_bytes >= 0)
   )`,
  'CREATE INDEX ix_files_category_created_at ON files (category, created_at)',
  'CREATE INDEX ix_files_created_at ON files (created_at)',
  `CREATE TABLE upload_sessions (
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     category varchar(32) NOT NULL,
     filename varchar(255) NOT NULL,
     content_type varchar(255) NOT NULL,
     size_bytes bigint NOT NULL,
     chunk_size_bytes integer NOT NULL,
     total_chunks integer NOT NULL,
     encrypted boolean NOT NULL,
     storage varchar(16) NOT NULL,
     expected_sha256 varchar(64),
     region varchar(16),
     attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
     status varchar(16) NOT NULL DEFAULT 'active',
     lease_until timestamptz,
     file_id uuid,
     created_by varchar(64) NOT NULL,
     trace_id varchar(64) NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     CONSTRAINT pk_upload_sessions PRIMARY KEY (id),
     CONSTRAINT fk_upload_sessions_file_id_files FOREIGN KEY (file_id) REFERENCES files (id),
     CONSTRAINT ck_upload_sessions_category CHECK (category IN (${CATEGORIES})),
     CONSTRAINT ck_upload_sessions_storage CHECK (storage IN (${STORAGES})),
     CONSTRAINT ck_upload_sessions_status
       CHECK (status IN ('active', 'completing', 'completed', 'aborted')),
     CONSTRAINT ck_upload_sessions_region CHECK (region IS NULL OR region IN (${REGIONS})),
     CONSTRAINT ck_upload_sessions_expected_sha256_hex
       CHECK (expected_sha256 IS NULL OR expected_sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_upload_sessions_sizes
       CHECK (size_bytes >= 0 AND total_chunks >= 0 AND chunk_size_bytes > 0)
   )`,
  'CREATE INDEX ix_upload_sessions_status_expires_at ON upload_sessions (status, expires_at)',
  `CREATE TABLE upload_chunks (
     upload_id uuid NOT NULL,
     chunk_index integer NOT NULL,
     size_bytes integer NOT NULL,
     sha256 varchar(64) NOT NULL,
     storage varchar(16) NOT NULL,
     storage_key varchar(512) NOT NULL,
     received_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT pk_upload_chunks PRIMARY KEY (upload_id, chunk_index),
     CONSTRAINT fk_upload_chunks_upload_id_upload_sessions
       FOREIGN KEY (upload_id) REFERENCES upload_sessions (id) ON DELETE CASCADE,
     CONSTRAINT ck_upload_chunks_chunk_index CHECK (chunk_index >= 0),
     CONSTRAINT ck_upload_chunks_size CHECK (size_bytes >= 0),
     CONSTRAINT ck_upload_chunks_sha256_hex CHECK (sha256 ~ ${SHA256_HEX}),
     CONSTRAINT ck_upload_chunks_storage CHECK (storage IN (${STORAGES}))
   )`,
  `CREATE TABLE meter_readings (
     reading_id varchar(64) NOT NULL,
     meter_id varchar(64) NOT NULL,
     region varchar(16) NOT NULL,
     measured_at timestamptz NOT NULL,
     kwh numeric(12, 3) NOT NULL,
     voltage numeric(6, 2),
     file_id uuid NOT NULL,
     received_at timestamptz NOT NULL DEFAULT now(),
     trace_id varchar(64) NOT NULL,
     CONSTRAINT pk_meter_readings PRIMARY KEY (reading_id),
     CONSTRAINT fk_meter_readings_file_id_files FOREIGN KEY (file_id) REFERENCES files (id)
       DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT ck_meter_readings_region CHECK (region IN (${REGIONS})),
     CONSTRAINT ck_meter_readings_kwh CHECK (kwh >= 0)
   )`,
  'CREATE INDEX ix_meter_readings_region_measured_at ON meter_readings (region, measured_at)',
  'CREATE INDEX ix_meter_readings_meter_id_measured_at ON meter_readings (meter_id, measured_at)',
  'CREATE INDEX ix_meter_readings_file_id ON meter_readings (file_id)',
  `CREATE TABLE audit_log (
     id bigserial NOT NULL,
     ts timestamptz NOT NULL DEFAULT now(),
     actor varchar(64) NOT NULL,
     action varchar(64) NOT NULL,
     outcome varchar(16) NOT NULL,
     category varchar(32),
     file_id uuid,
     trace_id varchar(64),
     details jsonb NOT NULL DEFAULT '{}'::jsonb,
     CONSTRAINT pk_audit_log PRIMARY KEY (id),
     CONSTRAINT ck_audit_log_outcome CHECK (outcome IN ('success', 'failure', 'denied'))
   )`,
  'CREATE INDEX ix_audit_log_ts ON audit_log (ts)',
  'CREATE INDEX ix_audit_log_file_id ON audit_log (file_id)',
  'CREATE INDEX ix_audit_log_trace_id ON audit_log (trace_id)',
  `INSERT INTO policies
     (category, primary_storage, fallback_storage, encrypted, chunk_size_bytes, max_concurrency)
   VALUES
     ('meter_reading', 'db', 's3', false, 1048576, 16),
     ('fault_record', 's3', 'db', false, 4194304, 8),
     ('connection_doc', 's3', 'db', true, 2097152, 4),
     ('drone_video', 'ftp', 's3', false, 8388608, 4)`,
];

const DOWN = [
  'DROP TABLE audit_log',
  'DROP TABLE meter_readings',
  'DROP TABLE upload_chunks',
  'DROP TABLE upload_sessions',
  'DROP TABLE files',
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
