import type { ColumnType, Generated } from 'kysely';
import type {
  AuditOutcome,
  Category,
  FileStatus,
  Region,
  Role,
  StorageName,
  UploadStatus,
} from '../common/domain';

/**
 * Kysely view of the metadata schema created by migrations/0001_initial.ts.
 * node-postgres returns int8 and numeric as strings, timestamptz as Date and jsonb parsed.
 */

type DefaultNow = ColumnType<Date, Date | string | undefined, Date | string>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Int8 = ColumnType<string, number | bigint | string, number | bigint | string>;
type DecimalText = ColumnType<string, number | string, number | string>;
type NullableDecimalText = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;
type JsonObject = ColumnType<Record<string, unknown>, string | undefined, string>;

export interface UsersTable {
  id: Generated<string>;
  username: string;
  password_hash: string;
  role: Role;
  created_at: DefaultNow;
}

export interface PoliciesTable {
  category: Category;
  primary_storage: StorageName;
  fallback_storage: StorageName | null;
  encrypted: boolean;
  chunk_size_bytes: number;
  max_concurrency: number;
  version: Generated<number>;
  updated_at: DefaultNow;
  updated_by: string | null;
}

export interface FilesTable {
  id: Generated<string>;
  category: Category;
  original_name: string;
  content_type: string;
  size_bytes: Int8;
  sha256: string;
  storage: StorageName;
  storage_key: string;
  stored_size_bytes: Int8;
  stored_sha256: string;
  encrypted: boolean;
  status: ColumnType<FileStatus, FileStatus | undefined, FileStatus>;
  region: Region | null;
  attributes: JsonObject;
  uploaded_by: string;
  trace_id: string;
  created_at: DefaultNow;
  last_verified_at: NullableTimestamp;
  corrupted_at: NullableTimestamp;
}

export interface UploadSessionsTable {
  id: Generated<string>;
  category: Category;
  filename: string;
  content_type: string;
  size_bytes: Int8;
  chunk_size_bytes: number;
  total_chunks: number;
  encrypted: boolean;
  storage: StorageName;
  expected_sha256: string | null;
  region: Region | null;
  attributes: JsonObject;
  status: ColumnType<UploadStatus, UploadStatus | undefined, UploadStatus>;
  lease_until: NullableTimestamp;
  file_id: string | null;
  created_by: string;
  trace_id: string;
  created_at: DefaultNow;
  updated_at: DefaultNow;
  expires_at: Timestamp;
}

export interface UploadChunksTable {
  upload_id: string;
  chunk_index: number;
  size_bytes: number;
  sha256: string;
  storage: StorageName;
  storage_key: string;
  received_at: DefaultNow;
}

export interface MeterReadingsTable {
  reading_id: string;
  meter_id: string;
  region: Region;
  measured_at: Timestamp;
  kwh: DecimalText;
  voltage: NullableDecimalText;
  file_id: string;
  received_at: DefaultNow;
  trace_id: string;
}

export interface AuditLogTable {
  id: Generated<string>;
  ts: DefaultNow;
  actor: string;
  action: string;
  outcome: AuditOutcome;
  category: Category | null;
  file_id: string | null;
  trace_id: string | null;
  details: JsonObject;
}

export interface Database {
  users: UsersTable;
  policies: PoliciesTable;
  files: FilesTable;
  upload_sessions: UploadSessionsTable;
  upload_chunks: UploadChunksTable;
  meter_readings: MeterReadingsTable;
  audit_log: AuditLogTable;
}
