/** Domain vocabulary shared by the API, the services and the database schema. */

export const CATEGORIES = [
  'meter_reading',
  'fault_record',
  'connection_doc',
  'drone_video',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories people upload from the UI. Meter readings arrive only through the meter API. */
export const MANUAL_CATEGORIES: readonly Category[] = [
  'fault_record',
  'connection_doc',
  'drone_video',
];

export const STORAGES = ['s3', 'ftp', 'db'] as const;
export type StorageName = (typeof STORAGES)[number];

export const REGIONS = ['muntenia', 'banat', 'dobrogea'] as const;
export type Region = (typeof REGIONS)[number];

export const ROLES = ['admin', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const UPLOAD_STATUSES = ['active', 'completing', 'completed', 'aborted'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const FILE_STATUSES = ['stored', 'corrupted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const MIN_CHUNK_SIZE_BYTES = 64 * 1024;
export const MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENCY_LIMIT = 256;
