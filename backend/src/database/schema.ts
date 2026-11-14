import type { ColumnType, Generated } from 'kysely';
import type {
  Category,
  IntegrityState,
  Origin,
  Role,
  StorageName,
  UploadState,
  Zone,
} from '../common/domain';

/**
 * Kysely view of the metadata schema created by migrations/0001_initial.ts and 0002_guarantees_alerts.ts.
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
/** jsonb: written as a JSON string (JSON.stringify), read back parsed. */
type Json<T> = ColumnType<T, string | undefined, string>;
type NullableJson<T> = ColumnType<T | null, string | null | undefined, string | null>;

export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  created_at: DefaultNow;
}

export interface PoliciesTable {
  category: Category;
  version: Generated<number>;
  primary_storage: StorageName;
  fallback_storage: StorageName | null;
  encrypted: boolean;
  chunk_size_bytes: number;
  max_parallel: number;
  max_concurrency: number;
  max_file_size_bytes: Int8;
  allowed_types: Json<string[]>;
  retention_days: number;
  updated_at: DefaultNow;
  updated_by: Generated<string>;
}

export interface PolicyChangeRow {
  field: string;
  from: string | null;
  to: string | null;
}

export interface PolicyVersionsTable {
  category: Category;
  version: number;
  snapshot: Json<Record<string, unknown>>;
  changes: Json<PolicyChangeRow[]>;
  changed_by: string;
  changed_at: DefaultNow;
}

export interface FilesTable {
  id: Generated<string>;
  category: Category;
  display_name: string;
  mime_type: string;
  size_bytes: Int8;
  sha256: string;
  client_sha256: string | null;
  storage: StorageName;
  storage_key: string;
  stored_size_bytes: Int8;
  stored_sha256: string;
  encrypted: boolean;
  used_fallback: Generated<boolean>;
  integrity: IntegrityState;
  policy_version: number;
  zone: Zone | null;
  origin: Generated<Origin>;
  metadata: Json<Record<string, unknown>>;
  pii_encrypted: string | null;
  uploaded_by: string | null;
  upload_trace_id: string;
  upload_started_at: NullableTimestamp;
  created_at: DefaultNow;
  last_verified_at: NullableTimestamp;
  corrupted_at: NullableTimestamp;
}

export interface UploadSessionsTable {
  id: Generated<string>;
  idempotency_key: string;
  category: Category;
  file_name: string;
  display_name: string;
  mime_type: string;
  file_size: Int8;
  chunk_size: number;
  part_count: number;
  max_parallel: number;
  policy_version: number;
  encrypted: boolean;
  primary_storage: StorageName;
  fallback_storage: StorageName | null;
  zone: Zone | null;
  metadata: Json<Record<string, unknown>>;
  pii_encrypted: string | null;
  status: Generated<UploadState>;
  client_sha256: string | null;
  result: NullableJson<Record<string, unknown>>;
  error: NullableJson<{ code: string; message: string }>;
  file_id: string | null;
  created_by: string;
  started_as_role: Role;
  trace_id: string;
  created_at: DefaultNow;
  updated_at: DefaultNow;
  expires_at: Timestamp;
  /** How often the uploader came back to resume (GET /uploads/{id} with parts received). */
  resume_count: Generated<number>;
}

export interface UploadPartsTable {
  upload_id: string;
  part_number: number;
  size_bytes: number;
  sha256: string;
  storage: StorageName;
  storage_key: string;
  received_at: DefaultNow;
}

export interface MeterReadingsTable {
  reading_id: string;
  meter_id: string;
  zone: Zone;
  reading_time: Timestamp;
  kwh: DecimalText;
  sequence: Int8;
  origin: Origin;
  file_id: string;
  received_at: DefaultNow;
  trace_id: string;
}

export interface MeterBatchesTable {
  id: Generated<string>;
  at: DefaultNow;
  received: number;
  stored: number;
  duplicates: number;
  origin: Origin;
  file_id: string | null;
  trace_id: string;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: DefaultNow;
  actor: string;
  acting_as: Role | null;
  demo: Generated<boolean>;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  category: Category | null;
  file_id: string | null;
  reason: string | null;
  details: string | null;
  trace_id: string | null;
  /** The client of the request (X-Forwarded-For from a trusted proxy, else the TCP peer). */
  client_ip: string | null;
}

export interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  storage: StorageName | null;
  errorCode: string | null;
}

export interface OperationsTable {
  id: Generated<string>;
  trace_id: string;
  operation: string;
  category: Category | null;
  storage: StorageName | null;
  file_id: string | null;
  status: 'ok' | 'error';
  started_at: Timestamp;
  duration_ms: number;
  size_bytes: Int8 | null;
  spans: Json<SpanRow[]>;
}

export type AlertState = 'at_risk' | 'violated' | 'resolved';

export interface AlertsTable {
  id: Generated<string>;
  category: Category;
  state: AlertState;
  cause_code: string;
  cause_facts: Json<Record<string, unknown>>;
  raised_at: DefaultNow;
  updated_at: DefaultNow;
  resolved_at: NullableTimestamp;
  acknowledged_at: NullableTimestamp;
  acknowledged_by: string | null;
  trace_id: string | null;
}

export interface Database {
  users: UsersTable;
  policies: PoliciesTable;
  policy_versions: PolicyVersionsTable;
  files: FilesTable;
  upload_sessions: UploadSessionsTable;
  upload_parts: UploadPartsTable;
  meter_readings: MeterReadingsTable;
  meter_batches: MeterBatchesTable;
  audit_log: AuditLogTable;
  operations: OperationsTable;
  alerts: AlertsTable;
}
