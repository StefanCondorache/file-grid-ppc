/** Upload engine vocabulary (docs/frontend/architecture/upload-engine.md §4, §11). Framework-free. */

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
