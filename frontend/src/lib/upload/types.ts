/** Upload engine vocabulary (docs/frontend/architecture/upload-engine.md §4, §11). Framework-free. */
import type { Role } from '@/lib/api/types';

export type { Role };

/** Category ids of the real backend (docs/api.md "Basics"); the UI shows Romanian labels. */
export const UPLOAD_CATEGORIES = ['fault_records', 'connection_documents', 'drone_videos'] as const;
export type UploadCategoryId = (typeof UPLOAD_CATEGORIES)[number];

/** Storage ids of the real backend; displayed as S3, FTP, PostgreSQL. */
export type StorageId = 's3' | 'ftp' | 'db';

/** The policy fields the engine needs, frozen when an upload starts (upload-engine.md §5, UE-7). */
export interface PolicySnapshot {
  category: UploadCategoryId;
  version: number;
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  chunkSize: number;
  maxParallel: number;
  maxFileSize: number;
  allowedTypes: string[];
}

export const UPLOAD_STATES = [
  'queued',
  'hashing',
  'uploading',
  'paused',
  'connection_lost',
  'verifying',
  'verified',
  'failed',
  'needs_file',
] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

export type PauseReason = 'user' | 'offline' | 'session' | 'logout';

export type FailReason =
  | 'forbidden'
  | 'upload_gone'
  | 'too_large'
  | 'policy_violation'
  | 'file_changed'
  | 'different_file'
  | 'checksum_mismatch'
  | 'retries_exhausted'
  | 'unknown';

/** Where a paused, re-attached or retried upload continues. */
export type ResumePhase = 'hashing' | 'uploading' | 'verifying';

export type UploadEvent =
  | { type: 'SLOT_FREE' }
  | { type: 'HASH_DONE' }
  | { type: 'FILE_MISSING' }
  | { type: 'PART_OK' }
  | { type: 'ALL_PARTS_OK' }
  | { type: 'RETRY_SCHEDULED' }
  | { type: 'RETRY_FIRES' }
  | { type: 'OFFLINE' }
  | { type: 'ONLINE_CONFIRMED' }
  | { type: 'PAUSE'; reason: PauseReason }
  | { type: 'RESUME'; to: ResumePhase }
  | { type: 'FILE_ATTACHED'; to: ResumePhase }
  | { type: 'COMPLETE_MATCH' }
  | { type: 'COMPLETE_PENDING' }
  | { type: 'PARTS_MISSING' }
  | { type: 'FAIL'; reason: FailReason }
  | { type: 'RETRY'; to: ResumePhase }
  | { type: 'RESTORE' };

export type UploadEventType = UploadEvent['type'];

/** What survives a reload, in IndexedDB (upload-engine.md §8.1). No bytes, no File, no PII (pii.ts). */
export interface PersistedUpload {
  localId: string;
  /** The real user: records of other users are never shown or resumed (BA-65). */
  userId: string;
  startedByRole: Role;
  /** Idempotency-Key of POST /uploads, written before the call. */
  clientKey: string;
  uploadId: string | null;
  category: UploadCategoryId;
  state: UploadState;
  pauseReason?: PauseReason;
  failReason?: FailReason;
  /** `name` is omitted for categories with personal data; `nameHash` = SHA-256 of the name. */
  fingerprint: { nameHash: string; name?: string; size: number; lastModified: number; type: string };
  /** Server-confirmed policy snapshot (from POST /uploads), never refreshed. */
  policy: PolicySnapshot | null;
  chunkSize: number | null;
  partCount: number | null;
  fileSha256?: string;
  partSha256?: string[];
  /** Bitset of server-confirmed parts, bit n-1 = part n. */
  confirmed: Uint8Array;
  safeMetadata: Record<string, string>;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}
