import { ApiError } from '@/lib/api/errors';
import { ro } from '@/lib/i18n/ro';
import { STORAGE_LABEL } from '@/lib/i18n/ro/upload';
import { errorBody } from './api';
import type { CompleteResult, UploadMetadata } from './contract';
import type { RateTracker } from './progress';
import { bitsetHas } from './repo';
import type { Scheduler } from './scheduler';
import { PART_CONFIRMED, PART_IN_FLIGHT, PART_PENDING, PART_RETRYING, type UploadItemView } from './store';
import type { FailReason, PauseReason, PersistedUpload, ResumePhase, UploadState } from './types';

/** The engine's in-memory upload. Mutable and private to the engine; the UI only ever sees `toView` snapshots. */
export interface Item {
  rec: PersistedUpload;
  file: File | null;
  handle: unknown;
  /** Kept in memory only (never persisted for connection documents). */
  fileName: string;
  /** Full metadata, personal data included, released as soon as POST /uploads succeeds. */
  pii: UploadMetadata | null;
  state: UploadState;
  pauseReason: PauseReason | null;
  failReason: FailReason | null;
  resumeTo: ResumePhase;
  hashedBytes: number;
  inflight: Map<number, number>;
  retrying: Set<number>;
  retries: number;
  retryAt: number | null;
  offline: boolean;
  lastError: unknown;
  result: CompleteResult | null;
  needsPermission: boolean;
  /** Bumped whenever work stops (pause, cancel, failure): async continuations of an older run are dropped. */
  run: number;
  scheduler: Scheduler | null;
  abort: AbortController | null;
  timer: unknown;
  unsubscribeNet: (() => void) | null;
  tracker: RateTracker;
  extraMessage: string | null;
}

export function partSize(rec: PersistedUpload, n: number): number {
  const chunk = rec.chunkSize ?? 0;
  return n < (rec.partCount ?? 0) ? chunk : rec.fingerprint.size - chunk * ((rec.partCount ?? 1) - 1);
}

export function confirmedBytes(rec: PersistedUpload): number {
  let total = 0;
  for (let n = 1; n <= (rec.partCount ?? 0); n++) if (bitsetHas(rec.confirmed, n)) total += partSize(rec, n);
  return total;
}

export function inflightBytes(item: Item): number {
  let total = 0;
  for (const sent of item.inflight.values()) total += sent;
  return total;
}

/** The phase a paused, re-attached or retried upload continues in. */
export function phaseOf(item: Item): ResumePhase {
  if (!item.rec.uploadId || !item.rec.partSha256) return 'hashing';
  return item.state === 'verifying' ? 'verifying' : 'uploading';
}

function storageMessage(item: Item): string | null {
  if (!(item.lastError instanceof ApiError) || item.lastError.code !== 'STORAGE_UNAVAILABLE') return null;
  const id = errorBody(item.lastError)?.storage ?? item.rec.policy?.primaryStorage;
  return id ? ro.upload.storageDown(STORAGE_LABEL[id] ?? id.toUpperCase()) : null;
}

function message(item: Item): string | null {
  const t = ro.upload;
  if (item.extraMessage) return item.extraMessage;
  if (item.state === 'failed' && item.failReason) return t.failReason[item.failReason];
  if (item.state === 'paused' && item.pauseReason) return t.pauseReason[item.pauseReason];
  if (item.state === 'needs_file') return item.needsPermission ? t.needsPermission : t.needsFile;
  if (item.state === 'connection_lost' && item.offline) return t.offline;
  return storageMessage(item) ?? (item.state === 'connection_lost' ? t.retrying : null);
}

function partCells(item: Item): Uint8Array | null {
  const count = item.rec.partCount;
  if (!count) return null;
  const cells = new Uint8Array(count);
  for (let n = 1; n <= count; n++) {
    cells[n - 1] =
      item.state === 'verified' || bitsetHas(item.rec.confirmed, n)
        ? PART_CONFIRMED
        : item.inflight.has(n)
          ? PART_IN_FLIGHT
          : item.retrying.has(n)
            ? PART_RETRYING
            : PART_PENDING;
  }
  return cells;
}

export function toView(item: Item): UploadItemView {
  const { rec } = item;
  const done = confirmedBytes(rec);
  const moving = item.state === 'uploading';
  const error = item.lastError instanceof ApiError ? item.lastError : null;
  return {
    id: rec.localId,
    ownerUserId: rec.userId,
    startedAsRole: rec.startedByRole,
    category: rec.category,
    displayName: rec.displayName,
    size: rec.fingerprint.size,
    state: item.state,
    pauseReason: item.state === 'paused' ? item.pauseReason : null,
    failReason: item.state === 'failed' ? item.failReason : null,
    message: message(item),
    errorCode: error?.code ?? null,
    traceId: item.result?.traceId ?? error?.traceId ?? null,
    hashedBytes: item.hashedBytes,
    bytesConfirmed: item.state === 'verified' ? rec.fingerprint.size : done,
    bytesInFlight: moving || item.state === 'connection_lost' ? inflightBytes(item) : 0,
    speedBps: moving ? item.tracker.speed() : null,
    etaS: moving ? item.tracker.eta(rec.fingerprint.size - done - inflightBytes(item)) : null,
    retryAt: item.state === 'connection_lost' && !item.offline ? item.retryAt : null,
    offline: item.offline,
    retries: item.retries,
    partCount: rec.partCount,
    parts: partCells(item),
    policyVersion: rec.policy?.version ?? null,
    primaryStorage: rec.policy?.primaryStorage ?? null,
    fallbackStorage: rec.policy?.fallbackStorage ?? null,
    encryptionAtRest: rec.policy?.encryptionAtRest ?? false,
    chunkSize: rec.chunkSize,
    maxParallel: rec.policy?.maxParallel ?? null,
    clientSha256: rec.fileSha256 ?? null,
    result: item.result,
    needsPermission: item.needsPermission,
    resumable: item.state === 'failed' && item.failReason === 'retries_exhausted',
  };
}
