import { ApiError } from '@/lib/api/errors';
import type { PartTransport } from './api';
import type { PartReceipt } from './contract';
import { backoffMs } from './backoff';
import type { NetMonitor } from './net';
import type { Clock, FailReason } from './types';

/** What the scheduler needs to send the parts of one upload; `isConfirmed` reads the engine's bitset. */
export interface ActiveUpload {
  uploadId: string;
  file: Blob;
  chunkSize: number;
  partCount: number;
  /** Hex SHA-256 of part n at index n-1 (from the hash-first pass). */
  partHashes: readonly string[];
  isConfirmed(n: number): boolean;
  maxParallel: number;
}

export type SchedulerSignal =
  | { type: 'part_started'; n: number }
  | { type: 'part_progress'; n: number; sent: number }
  | { type: 'part_ok'; n: number; receipt: PartReceipt }
  | { type: 'part_retry'; n: number; attempt: number; retryAt: number; error: unknown }
  | { type: 'waiting'; retryAt: number }
  | { type: 'offline' }
  | { type: 'online' }
  | { type: 'all_done' }
  | { type: 'session'; error: ApiError }
  | { type: 'reconcile'; error: ApiError }
  | { type: 'fatal'; reason: FailReason; error: unknown };

export type ErrorClass =
  | { kind: 'abort' }
  | { kind: 'retry' }
  | { kind: 'checksum' }
  | { kind: 'session' }
  | { kind: 'reconcile' }
  | { kind: 'fatal'; reason: FailReason };

export const MAX_ATTEMPTS = 10;
export const CHECKSUM_LIMIT = 3;
const MAX_PARALLEL = 6;
const RETRYABLE_4XX = [408, 425, 429];
const CHECKSUM_CODES = ['PART_CHECKSUM_MISMATCH', 'PART_SIZE_MISMATCH'];

/** DOMException is not an Error subclass in every realm: match the name. */
export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Status handling of upload-engine.md §6, adapted to the backend's codes (docs/api.md). */
export function classifyError(error: unknown): ErrorClass {
  if (isAbort(error)) return { kind: 'abort' };
  if (!(error instanceof ApiError) || error.status === 0) return { kind: 'retry' };
  const { status, code } = error;
  if (status === 401) return { kind: 'session' };
  if (status === 403) return { kind: 'fatal', reason: 'forbidden' };
  if (status === 404) return { kind: 'fatal', reason: 'upload_gone' };
  if (status === 409) return { kind: 'reconcile' };
  if (status === 413) return { kind: 'fatal', reason: 'too_large' };
  if (status === 422 && CHECKSUM_CODES.includes(code)) return { kind: 'checksum' };
  if (status === 400 || status === 415 || status === 422) return { kind: 'fatal', reason: 'policy_violation' };
  if (RETRYABLE_4XX.includes(status) || status >= 500) return { kind: 'retry' };
  return { kind: 'fatal', reason: 'unknown' };
}

/**
 * Sends the parts of one upload in parallel (fixed ceiling `clamp(maxParallel, 1, 6)`, P0): due retries first, then
 * the lowest unconfirmed part. Retryable failures back off with full jitter (and honour Retry-After); offline time
 * never counts as an attempt. Every result of an older generation (before a pause, offline or restart) is ignored,
 * so each part is confirmed exactly once.
 */
export function createScheduler(deps: { transport: PartTransport; net: NetMonitor; clock: Clock; rng: () => number; onSignal(s: SchedulerSignal): void }) {
  const { transport, net, clock, rng, onSignal: emit } = deps;
  let u: ActiveUpload | null = null;
  let running = false;
  let gen = 0;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let inflight = new Map<number, AbortController>();
  let confirmed = new Set<number>();
  let attempts = new Map<number, number>();
  let checksumFails = new Map<number, number>();
  let retryAt = new Map<number, number>();

  function clearTimer(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  /** Aborts in-flight parts; their late results belong to an old generation and are dropped. */
  function abortInflight(): void {
    gen++;
    const controllers = [...inflight.values()];
    inflight = new Map();
    controllers.forEach((ac) => ac.abort());
    clearTimer();
  }

  function halt(): void {
    running = false;
    abortInflight();
    unsubscribe?.();
    unsubscribe = null;
  }

  function nextPart(now: number): number | null {
    let due: number | null = null;
    for (const [n, at] of retryAt) if (at <= now && !inflight.has(n) && (due === null || n < due)) due = n;
    if (due !== null) return due;
    for (let n = 1; n <= u!.partCount; n++) if (!confirmed.has(n) && !inflight.has(n) && !retryAt.has(n)) return n;
    return null;
  }

  function pump(): void {
    if (!running || !u || !net.online) return;
    clearTimer();
    const limit = Math.min(MAX_PARALLEL, Math.max(1, u.maxParallel));
    const now = clock.now();
    while (inflight.size < limit) {
      const n = nextPart(now);
      if (n === null) break;
      launch(n);
    }
    if (inflight.size > 0) return;
    if (confirmed.size === u.partCount) {
      halt();
      emit({ type: 'all_done' });
      return;
    }
    const soonest = Math.min(...retryAt.values());
    if (Number.isFinite(soonest)) {
      timer = clock.setTimeout(pump, Math.max(0, soonest - now));
      emit({ type: 'waiting', retryAt: soonest });
    }
  }

  function launch(n: number): void {
    const up = u!;
    const ac = new AbortController();
    const mine = gen;
    inflight.set(n, ac);
    retryAt.delete(n);
    const start = (n - 1) * up.chunkSize;
    // Sliced at send time: a lazy Blob reference, never a copy of the bytes.
    const body = up.file.slice(start, Math.min(up.file.size, start + up.chunkSize));
    emit({ type: 'part_started', n });
    transport
      .send({
        uploadId: up.uploadId,
        partNumber: n,
        body,
        sha256Hex: up.partHashes[n - 1] ?? '',
        signal: ac.signal,
        onProgress: (sent) => {
          if (mine === gen) emit({ type: 'part_progress', n, sent });
        },
      })
      .then(
        (receipt) => {
          if (mine !== gen) return;
          inflight.delete(n);
          confirmed.add(n);
          attempts.delete(n);
          net.reportSuccess();
          emit({ type: 'part_ok', n, receipt });
          pump();
        },
        (error: unknown) => {
          if (mine !== gen) return;
          inflight.delete(n);
          onFailure(n, error);
        },
      );
  }

  function schedule(n: number, attempt: number, error: unknown): void {
    const hinted = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
    const at = clock.now() + Math.max(backoffMs(attempt - 1, rng), hinted);
    retryAt.set(n, at);
    emit({ type: 'part_retry', n, attempt, retryAt: at, error });
    pump();
  }

  function stopWith(signal: SchedulerSignal): void {
    halt();
    emit(signal);
  }

  function onFailure(n: number, error: unknown): void {
    const c = classifyError(error);
    if (c.kind === 'abort') return pump();
    if (c.kind === 'session') return stopWith({ type: 'session', error: error as ApiError });
    if (c.kind === 'reconcile') return stopWith({ type: 'reconcile', error: error as ApiError });
    if (c.kind === 'fatal') return stopWith({ type: 'fatal', reason: c.reason, error });
    if (c.kind === 'checksum') {
      const k = (checksumFails.get(n) ?? 0) + 1;
      checksumFails.set(n, k);
      return k >= CHECKSUM_LIMIT ? stopWith({ type: 'fatal', reason: 'file_changed', error }) : schedule(n, k, error);
    }
    if (error instanceof ApiError && error.status === 0) net.reportNetworkError();
    // While offline nothing counts: the upload waits for the network, it does not fail.
    const a = (attempts.get(n) ?? 0) + (net.online ? 1 : 0);
    attempts.set(n, a);
    if (a >= MAX_ATTEMPTS) return stopWith({ type: 'fatal', reason: 'retries_exhausted', error });
    schedule(n, Math.max(1, a), error);
  }

  function onNet(online: boolean): void {
    if (!running) return;
    if (online) {
      emit({ type: 'online' });
      pump();
      return;
    }
    abortInflight();
    emit({ type: 'offline' });
  }

  return {
    /** (Re)starts with fresh attempt counters; parts the engine already confirmed are skipped. */
    start(next: ActiveUpload): void {
      halt();
      u = next;
      running = true;
      confirmed = new Set(Array.from({ length: next.partCount }, (_, i) => i + 1).filter((n) => next.isConfirmed(n)));
      attempts = new Map();
      checksumFails = new Map();
      retryAt = new Map();
      unsubscribe = net.subscribe(onNet);
      if (!net.online) {
        emit({ type: 'offline' });
        return;
      }
      pump();
    },
    /** Pause, session end or cancel: abort in-flight parts without counting attempts. */
    stop(): void {
      halt();
    },
    get running(): boolean {
      return running;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
