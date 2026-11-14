/**
 * Policy vocabulary of the real backend (docs/api.md "Policies"). schema.d.ts still carries the proposal's ids
 * (`fault`, `S3`), so this slice keeps its own types and normalises responses (backend ask: regenerate the schema).
 */
export const POLICY_CATEGORIES = ['fault_records', 'drone_videos', 'connection_documents', 'meter_readings'] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const STORAGES = ['s3', 'ftp', 'db'] as const;
export type StorageId = (typeof STORAGES)[number];

export type PolicyUser = { id: string; username: string; displayName: string; role: string };

export interface PolicyDoc {
  category: PolicyCategory;
  version: number;
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  encryptionLocked: boolean;
  encryptionAlgorithm: string | null;
  chunkSize: number;
  maxParallel: number;
  maxConcurrency?: number;
  maxFileSize: number;
  allowedTypes: string[];
  retentionDays: number;
  updatedAt: string;
  updatedBy: PolicyUser | null;
}

/** Body of PUT /policies/{category}. */
export interface PolicyUpdate {
  baseVersion: number;
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  chunkSize: number;
  maxParallel: number;
  maxFileSize: number;
  allowedTypes: string[];
  retentionDays: number;
}

export type PolicyChange = { field: string; from: string | null; to: string | null };

export interface PolicyVersionEntry {
  version: number;
  policy: PolicyDoc | null;
  changedAt: string;
  changedBy: PolicyUser | null;
  changes: PolicyChange[];
}

const LEGACY_CATEGORY: Record<string, PolicyCategory> = { fault: 'fault_records', drone: 'drone_videos', connection: 'connection_documents', meter: 'meter_readings' };

export function toCategory(v: unknown): PolicyCategory | null {
  const s = String(v);
  return (POLICY_CATEGORIES as readonly string[]).includes(s) ? (s as PolicyCategory) : (LEGACY_CATEGORY[s] ?? null);
}

export function toStorage(v: unknown): StorageId | null {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return (STORAGES as readonly string[]).includes(s) ? (s as StorageId) : null;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Validates and normalises a policy body (never trust external data); accepts the proposal's ids too. */
export function toPolicy(raw: unknown): PolicyDoc {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const category = toCategory(p.category);
  const primary = toStorage(p.primaryStorage);
  if (!category || !primary || typeof p.version !== 'number') throw new Error('Unexpected policy from the server');
  return {
    category,
    version: p.version,
    primaryStorage: primary,
    fallbackStorage: toStorage(p.fallbackStorage),
    encryptionAtRest: p.encryptionAtRest === true,
    encryptionLocked: p.encryptionLocked === true,
    encryptionAlgorithm: typeof p.encryptionAlgorithm === 'string' ? p.encryptionAlgorithm : null,
    chunkSize: num(p.chunkSize),
    maxParallel: num(p.maxParallel, 1),
    maxConcurrency: typeof p.maxConcurrency === 'number' ? p.maxConcurrency : undefined,
    maxFileSize: num(p.maxFileSize),
    allowedTypes: Array.isArray(p.allowedTypes) ? p.allowedTypes.filter((t): t is string => typeof t === 'string') : [],
    retentionDays: num(p.retentionDays),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
    updatedBy: p.updatedBy && typeof p.updatedBy === 'object' ? (p.updatedBy as PolicyUser) : null,
  };
}
