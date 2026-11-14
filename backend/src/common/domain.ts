/**
 * Domain vocabulary shared by the API, the services, the metrics and the database schema.
 * Category and storage ids are the team contract from the README ("Contracte pentru P2/P3"): the same
 * strings are used in policies, Prometheus labels, Grafana dashboards, alerts and the UI.
 */

export const CATEGORIES = [
  'meter_readings',
  'fault_records',
  'connection_documents',
  'drone_videos',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories people upload from the UI. Meter readings arrive only through the meter API. */
export const UPLOAD_CATEGORIES = ['fault_records', 'connection_documents', 'drone_videos'] as const;
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

export const STORAGES = ['s3', 'ftp', 'db'] as const;
export type StorageName = (typeof STORAGES)[number];

export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const;
export type Zone = (typeof ZONES)[number];

/** Where a record came from, so generated data can be filtered out of lists and statistics. */
export const ORIGINS = ['manual', 'simulator', 'storm', 'seed'] as const;
export type Origin = (typeof ORIGINS)[number];

export const ROLES = ['teren', 'dispecerat', 'racordari', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'upload_drone',
  'upload_fault',
  'upload_connection',
  'view_drone',
  'view_fault',
  'view_connection',
  'reveal_pii',
  'view_meters',
  'view_observability',
  'view_statistics',
  'view_audit',
  'edit_policies',
  'demo_controls',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Role x capability matrix from docs/frontend/prd.md (FE-01); the backend enforces it. */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  teren: ['upload_drone', 'upload_fault', 'view_drone', 'view_fault'],
  dispecerat: ['upload_fault', 'view_drone', 'view_fault', 'view_meters'],
  racordari: ['upload_connection', 'view_connection'],
  auditor: [
    'view_drone',
    'view_fault',
    'view_connection',
    'reveal_pii',
    'view_meters',
    'view_observability',
    'view_statistics',
    'view_audit',
  ],
  // admin cannot unmask personal data: the presenter switches to auditor for that (deliberate).
  admin: [
    'upload_drone',
    'upload_fault',
    'upload_connection',
    'view_drone',
    'view_fault',
    'view_connection',
    'view_meters',
    'view_observability',
    'view_statistics',
    'view_audit',
    'edit_policies',
    'demo_controls',
  ],
};

export const UPLOAD_CAPABILITY: Readonly<Record<UploadCategory, Capability>> = {
  fault_records: 'upload_fault',
  connection_documents: 'upload_connection',
  drone_videos: 'upload_drone',
};

export const VIEW_CAPABILITY: Readonly<Record<Category, Capability>> = {
  meter_readings: 'view_meters',
  fault_records: 'view_fault',
  connection_documents: 'view_connection',
  drone_videos: 'view_drone',
};

export function capabilitiesOf(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export const UPLOAD_STATES = [
  'open',
  'verifying',
  'completed',
  'failed',
  'aborted',
  'expired',
] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

/** verified = client and server hashes matched; corrupt = a later read did not match. */
export const INTEGRITY_STATES = ['verified', 'server_verified', 'unverified', 'corrupt'] as const;
export type IntegrityState = (typeof INTEGRITY_STATES)[number];

export const MiB = 1024 * 1024;
/** Part size bounds from ADR-0005: big enough for few requests, small enough for Traefik's timeout. */
export const MIN_CHUNK_SIZE = 1 * MiB;
export const MAX_CHUNK_SIZE = 32 * MiB;
export const MAX_PARALLEL = 6;
