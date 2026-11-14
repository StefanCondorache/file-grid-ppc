import type { UploadEvent, UploadEventType, UploadState } from './types';

type Target = UploadState | ((event: UploadEvent) => UploadState);
type Row = Partial<Record<UploadEventType, Target>>;

/** The event's `to` field (RESUME, FILE_ATTACHED, RETRY carry the phase to continue in). */
const toPhase = (event: UploadEvent): UploadState => ('to' in event ? event.to : 'queued');

// Active states share these exits: pause, fatal failure, and restore (a reloaded record re-enters at `queued`).
const ACTIVE: Row = { PAUSE: 'paused', FAIL: 'failed', RESTORE: 'queued' };

/**
 * Transition table (upload-engine.md §11). The upload session is created at the start of `hashing`
 * because the real backend fixes the part size (docs/api.md, "Resumable upload").
 */
const TABLE: Record<UploadState, Row> = {
  queued: { ...ACTIVE, SLOT_FREE: 'hashing', FILE_MISSING: 'needs_file' },
  hashing: { ...ACTIVE, HASH_DONE: 'uploading', FILE_MISSING: 'needs_file' },
  uploading: { ...ACTIVE, PART_OK: 'uploading', ALL_PARTS_OK: 'verifying', RETRY_SCHEDULED: 'connection_lost', OFFLINE: 'connection_lost' },
  connection_lost: {
    ...ACTIVE,
    PART_OK: 'uploading',
    RETRY_FIRES: 'uploading',
    ONLINE_CONFIRMED: 'uploading',
    ALL_PARTS_OK: 'verifying',
    OFFLINE: 'connection_lost',
    RETRY_SCHEDULED: 'connection_lost',
  },
  verifying: { ...ACTIVE, COMPLETE_MATCH: 'verified', COMPLETE_PENDING: 'verifying', PARTS_MISSING: 'uploading', OFFLINE: 'connection_lost' },
  paused: { ...ACTIVE, RESUME: toPhase, FILE_MISSING: 'needs_file' },
  needs_file: { FILE_ATTACHED: toPhase, FAIL: 'failed', RESTORE: 'queued' },
  // `failed` keeps its state on restore; a resumable failure continues with RETRY, a different file with FILE_ATTACHED.
  failed: { RETRY: toPhase, FILE_ATTACHED: toPhase },
  verified: {},
};

/** Pure transition function; impossible events leave the state unchanged. */
export function transition(state: UploadState, event: UploadEvent): UploadState {
  const target = TABLE[state][event.type];
  if (target === undefined) return state;
  return typeof target === 'function' ? target(event) : target;
}

export function isTerminal(state: UploadState): boolean {
  return state === 'verified' || state === 'failed';
}
