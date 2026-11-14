/**
 * Upload engine facade (upload-engine.md §3–§14, frontend-architecture §3): the only API the UI calls. It wires the
 * state machine, the hash-first pass, the part scheduler, persistence and the network monitor, and publishes a
 * read model to `useUploadStore`. Framework-free; `uploadEngine` below is the module singleton.
 */
import { api as apiClient, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { ro } from '@/lib/i18n/ro';
import { createUploadApi, createXhrTransport, errorBody, type PartTransport, type UploadApi } from './api';
import { backoffMs } from './backoff';
import { rangesToParts, type CompleteResult, type UploadMetadata } from './contract';
import type { UploadControl } from './engine-port';
import { createWorkerHasher, type HashClient } from './hasher';
import { transition } from './machine';
import { createNetMonitor, createPingProbe, type NetMonitor } from './net';
import { persistableHandle, toPersistable } from './pii';
import { effectiveMime, isUsableChunkSize, partCount, partRange, validateFile } from './plan';
import { createSpeedMeter, type SpeedMeter } from './progress';
import { bitsetHas, bitsetNew, bitsetSet, createRepo, type UploadRepo } from './repo';
import { classifyError, createScheduler, isAbort, MAX_ATTEMPTS, type Scheduler, type SchedulerSignal } from './scheduler';
import { useUploadStore, type UploadErrorView, type UploadItemView } from './store';
import {
  realClock,
  type Clock,
  type FailReason,
  type PauseReason,
  type PersistedUpload,
  type ResumePhase,
  type Role,
  type UploadCategoryId,
  type UploadEvent,
  type UploadState,
} from './types';

export interface EnqueueInput {
  file: File;
  category: UploadCategoryId;
  /** May hold personal data: kept in memory until POST /uploads returns, never persisted (pii.ts). */
  metadata: UploadMetadata;
  /** Chromium `FileSystemFileHandle` from a drop or the picker; never persisted for personal-data categories. */
  handle?: unknown;
}

export interface UploadEngine extends UploadControl {
  /** Returns the local id at once; the upload waits in `queued` for a hashing slot. */
  enqueue(input: EnqueueInput): string;
  pause(id: string): void;
  /** Continues a paused upload, or a failed one that is resumable (retries exhausted). */
  resume(id: string): void;
  /** Stops the upload, drops its server session and its record; dismisses a finished row. */
  cancel(id: string): Promise<void>;
  /** Gives a restored upload its file back after checking it is the same one (upload-engine.md §8.4). */
  reattach(id: string, file: File): Promise<void>;
  pauseAll(reason: 'session' | 'logout'): void;
  resumeAll(ownerUserId: string): void;
  /** Shows the uploads of `userId` (and only theirs, BA-65) from IndexedDB; call on (app) mount. */
  restore(userId: string): Promise<void>;
  restoreAndResume(userId: string): Promise<void>;
}

export interface Identity {
  /** The real user: an upload belongs to the account, not to the acting role (BA-65). */
  userId: string;
  role: Role;
}

export interface EngineDeps {
  api: UploadApi;
  transport: PartTransport;
  hasher: HashClient;
  repo: UploadRepo;
  net: NetMonitor;
  clock: Clock;
  rng: () => number;
  /** Who is signed in now (GET /auth/me), asked when an upload starts. */
  whoami(): Promise<Identity>;
  newId(): string;
  /** Hex SHA-256 of a string (the file-name fingerprint). */
  sha256Text(text: string): Promise<string>;
}

const MAX_HASHING = 2;
/** The server drops a session after 24 h without parts, so an older record cannot be resumed. */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 2000;
const MAX_RECONCILES = 3;
const RUNNING: readonly UploadState[] = ['queued', 'hashing', 'uploading', 'connection_lost', 'verifying'];
/** Failures a "Reia" continues: the server still holds the parts. */
const RESUMABLE: readonly FailReason[] = ['retries_exhausted', 'unknown'];
const EMPTY_BITS = new Uint8Array(0);

/** A run that was paused, cancelled or superseded: its late results are dropped, never shown. */
class Stale extends Error {}

/** A failure decided by the engine itself (not an HTTP status), with the reason to show. */
class Failure extends Error {
  constructor(
    readonly reason: FailReason,
    readonly detail?: string,
    readonly cause?: unknown,
  ) {
    super(detail ?? reason);
  }
}

interface Job {
  id: string;
  clientKey: string;
  userId: string;
  role: Role | null;
  category: UploadCategoryId;
  size: number;
  displayName: string;
  createdAt: number;
  state: UploadState;
  pauseReason?: PauseReason;
  failReason?: FailReason;
  /** The persisted record; null until the upload starts (owner role and name hash known). */
  rec: PersistedUpload | null;
  /** Null after a reload until the user gives the file back. */
  file: File | null;
  handle: unknown;
  /** Full metadata, personal data included: memory only, dropped once POST /uploads returns. */
  metadata: UploadMetadata | null;
  result: CompleteResult | null;
  error: UploadErrorView | undefined;
  hashedBytes: number;
  inFlight: Map<number, number>;
  retrying: Set<number>;
  retryAt: number | undefined;
  offline: boolean;
  speed: SpeedMeter;
  scheduler: Scheduler | null;
  ac: AbortController;
  /** Bumped by every pause, cancel or new run; async work checks it after each await. */
  gen: number;
  reconciles: number;
}

const noop = () => {};

function errorView(error: unknown, message?: string): UploadErrorView {
  if (!(error instanceof ApiError)) return { code: 'UNKNOWN', message: message ?? ro.errors.generic };
  const known = (ro.errors as Record<string, string>)[error.code];
  return {
    code: error.code,
    message: message ?? known ?? (error.status > 0 ? error.message : ro.errors.NETWORK),
    traceId: error.traceId ?? undefined,
    storage: errorBody(error)?.storage,
  };
}

/** First, middle and last part: at most 3 parts are re-read to recognise a re-selected file (§8.4). */
export function samplePartNumbers(count: number): number[] {
  return [...new Set([1, Math.ceil(count / 2), count])];
}

export function createUploadEngine(deps: EngineDeps): UploadEngine {
  const { api, transport, hasher, repo, net, clock, rng } = deps;
  const jobs = new Map<string, Job>();
  let owner: string | null = null;

  // ---- read model ------------------------------------------------------------------------------------------

  function confirmedBytes(job: Job): number {
    const rec = job.rec;
    if (!rec?.chunkSize || !rec.partCount) return 0;
    let bytes = 0;
    for (let n = 1; n <= rec.partCount; n++) {
      if (!bitsetHas(rec.confirmed, n)) continue;
      const r = partRange(n, job.size, rec.chunkSize);
      bytes += r.end - r.start;
    }
    return bytes;
  }

  function view(job: Job, now: number): UploadItemView {
    const rec = job.rec;
    const r = job.result;
    const bytesConfirmed = confirmedBytes(job);
    let bytesInFlight = 0;
    for (const sent of job.inFlight.values()) bytesInFlight += sent;
    if (job.state === 'uploading') job.speed.sample(now, bytesConfirmed + bytesInFlight, job.size);
    const { speedBps, etaS } = job.state === 'uploading' ? job.speed.read(now) : { speedBps: null, etaS: null };
    return {
      id: job.id,
      displayName: job.displayName,
      category: job.category,
      size: job.size,
      bytesConfirmed,
      bytesInFlight,
      hashedBytes: job.hashedBytes,
      speedBps,
      etaS,
      state: job.state,
      pausedReason: job.pauseReason,
      failReason: job.failReason,
      retryAt: job.retryAt,
      retryInS: job.retryAt === undefined ? undefined : Math.max(0, Math.ceil((job.retryAt - now) / 1000)),
      offline: job.offline,
      clientSha256: rec?.fileSha256,
      serverSha256: r?.serverSha256,
      verdict: r?.verdict,
      fileId: r?.fileId,
      traceId: r?.traceId ?? job.error?.traceId,
      error: job.error,
      startedAsRole: job.role,
      ownerUserId: job.userId,
      availableAfterMs: r?.availableAfterMs,
      partCount: rec?.partCount ?? null,
      confirmed: rec?.confirmed ?? EMPTY_BITS,
      inFlightParts: [...job.inFlight.keys()].sort((a, b) => a - b),
      retryingParts: [...job.retrying].sort((a, b) => a - b),
      storage: r?.storage,
      usedFallback: r?.usedFallback,
      policyVersion: rec?.policy?.version,
    };
  }

  const dirty = new Set<string>();

  /** Writes the changed rows; only the signed-in owner's uploads are visible (BA-65, Review Focus 2). */
  function flush(): void {
    if (dirty.size === 0) return;
    const now = clock.now();
    const items = { ...useUploadStore.getState().items };
    for (const id of dirty) {
      const job = jobs.get(id);
      if (job && job.userId === owner) items[id] = view(job, now);
      else delete items[id];
    }
    dirty.clear();
    useUploadStore.setState({ items });
  }

  function changed(job: Job): void {
    dirty.add(job.id);
    flush();
  }

  function rebuild(): void {
    for (const id of jobs.keys()) dirty.add(id);
    const items = useUploadStore.getState().items;
    for (const id of Object.keys(items)) dirty.add(id);
    flush();
  }

  // ---- persistence -----------------------------------------------------------------------------------------

  function persist(job: Job): void {
    if (!job.rec) return;
    job.rec = { ...job.rec, state: job.state, pauseReason: job.pauseReason, failReason: job.failReason, updatedAt: clock.now() };
    // Best effort: the server stays the source of truth for received parts (GET /uploads/{id}); a lost write only
    // costs a re-check after a reload, so it must never stop the upload.
    repo.put(job.rec).catch(noop);
  }

  // ---- transitions -----------------------------------------------------------------------------------------

  /** Applies a machine event; returns the new state. Impossible events change nothing (machine.ts). */
  function fire(job: Job, event: UploadEvent): UploadState {
    const prev = job.state;
    const next = transition(prev, event);
    if (event.type === 'RESUME' || event.type === 'RETRY' || event.type === 'FILE_ATTACHED') job.error = undefined;
    job.state = next;
    job.pauseReason = next === 'paused' ? (event.type === 'PAUSE' ? event.reason : job.pauseReason) : undefined;
    job.failReason = next === 'failed' ? (event.type === 'FAIL' ? event.reason : job.failReason) : undefined;
    if (next !== 'connection_lost') {
      job.retryAt = undefined;
      job.offline = false;
    }
    if (next !== 'uploading') job.speed.reset();
    if (next !== prev) persist(job);
    if (prev === 'hashing' && next !== 'hashing') queueMicrotask(pumpQueue);
    changed(job);
    return next;
  }

  /** Stops whatever the job is doing (hashing, parts, complete, waits); returns the new generation. */
  function supersede(job: Job): number {
    job.gen++;
    job.ac.abort();
    job.ac = new AbortController();
    job.scheduler?.stop();
    job.inFlight.clear();
    job.retrying.clear();
    return job.gen;
  }

  function guard(job: Job, g: number): void {
    if (job.gen !== g || jobs.get(job.id) !== job) throw new Stale();
  }

  function pauseJob(job: Job, reason: PauseReason): void {
    supersede(job);
    fire(job, { type: 'PAUSE', reason });
  }

  function fail(job: Job, reason: FailReason, cause?: unknown, detail?: string): void {
    supersede(job);
    job.error = { ...errorView(cause), message: detail ?? ro.upload.failure[reason] };
    if (!(cause instanceof ApiError)) job.error.code = reason.toUpperCase();
    fire(job, { type: 'FAIL', reason });
  }

  function onError(job: Job, error: unknown): void {
    if (error instanceof Stale) return;
    if (error instanceof Failure) return fail(job, error.reason, error.cause, error.detail);
    const c = classifyError(error);
    if (c.kind === 'abort') return;
    if (c.kind === 'session') return pauseJob(job, 'session');
    if (c.kind === 'reconcile') return void reconcile(job);
    if (c.kind === 'fatal') return fail(job, c.reason, error);
    if (c.kind === 'checksum') return fail(job, 'file_changed', error);
    fail(job, 'retries_exhausted', error);
  }

  /** Where a paused, re-attached or retried upload continues. */
  function phase(job: Job): ResumePhase {
    const rec = job.rec;
    if (!rec?.uploadId || !rec.partCount || !rec.fileSha256 || !rec.partSha256) return 'hashing';
    for (let n = 1; n <= rec.partCount; n++) if (!bitsetHas(rec.confirmed, n)) return 'uploading';
    return 'verifying';
  }

  // ---- waiting ---------------------------------------------------------------------------------------------

  function sleep(job: Job, ms: number): Promise<void> {
    const signal = job.ac.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Stale());
      const onAbort = () => {
        clock.clearTimeout(timer);
        reject(new Stale());
      };
      const timer = clock.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function untilOnline(job: Job): Promise<void> {
    const signal = job.ac.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Stale());
      const onAbort = () => {
        unsubscribe();
        reject(new Stale());
      };
      const unsubscribe = net.subscribe((online) => {
        if (!online) return;
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** A JSON call retried like a part (§6): backoff with full jitter, Retry-After honoured, offline time not counted. */
  async function withRetry<T>(job: Job, g: number, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      guard(job, g);
      if (!net.online) await untilOnline(job);
      try {
        const out = await call();
        guard(job, g);
        return out;
      } catch (error) {
        guard(job, g);
        if (classifyError(error).kind !== 'retry' || attempt >= MAX_ATTEMPTS) throw error;
        if (error instanceof ApiError && error.status === 0) net.reportNetworkError();
        if (!net.online) attempt--;
        const hinted = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
        await sleep(job, Math.max(backoffMs(attempt, rng), hinted));
      }
    }
  }

  // ---- the pipeline ----------------------------------------------------------------------------------------

  /** Starts as many queued uploads as there are hashing slots (at most 2 hash or create at once). */
  function pumpQueue(): void {
    let hashing = 0;
    for (const job of jobs.values()) if (job.state === 'hashing') hashing++;
    for (const job of jobs.values()) {
      if (hashing >= MAX_HASHING) return;
      if (job.state !== 'queued' || !job.file || job.userId !== owner) continue;
      hashing++;
      fire(job, { type: 'SLOT_FREE' });
      void run(job);
    }
  }

  /** Runs the job from its current state: hashing (create + hash), uploading (parts) or verifying (complete). */
  async function run(job: Job): Promise<void> {
    const g = supersede(job);
    try {
      if (job.state === 'hashing') await prepare(job, g);
      if (job.state === 'uploading') startParts(job);
      else if (job.state === 'verifying') await verify(job, g);
    } catch (error) {
      if (job.gen === g) onError(job, error);
    }
  }

  async function createRecord(job: Job, g: number, file: File): Promise<PersistedUpload> {
    const who = await withRetry(job, g, () => deps.whoami());
    // Another account signed in since enqueue: keep the upload for its owner (BA-65, Review Focus 2).
    if (who.userId !== job.userId) throw new ApiError(401, 'UNAUTHENTICATED', 'A different user is signed in');
    job.role = who.role;
    changed(job);
    const policy = await withRetry(job, g, () => api.policy(job.category));
    const reasons = validateFile(file, policy);
    if (reasons.length > 0) throw new Failure('policy_violation', reasons.join(' '));
    const nameHash = await deps.sha256Text(file.name);
    guard(job, g);
    const now = clock.now();
    return toPersistable(
      {
        localId: job.id,
        userId: job.userId,
        startedByRole: who.role,
        clientKey: job.clientKey,
        uploadId: null,
        category: job.category,
        state: job.state,
        policy,
        chunkSize: null,
        partCount: null,
        confirmed: EMPTY_BITS,
        displayName: job.displayName,
        createdAt: job.createdAt,
        updatedAt: now,
        fileName: file.name,
        nameHash,
        size: file.size,
        lastModified: file.lastModified,
        type: effectiveMime(file),
        metadata: Object.fromEntries(Object.entries(job.metadata ?? {})),
      },
      job.category,
    );
  }

  /** `hashing`: create the session (the server fixes the part size), then the hash-first pass (UE-2). */
  async function prepare(job: Job, g: number): Promise<void> {
    const file = job.file;
    if (!file) throw new Failure('unknown');
    if (!job.rec) {
      job.rec = await createRecord(job, g, file);
      persist(job); // the Idempotency-Key is on disk before the POST (§12)
      const handle = persistableHandle(job.category, job.handle);
      if (handle) repo.putHandle(job.id, handle).catch(noop);
    }
    if (!job.rec.uploadId) {
      const rec = job.rec;
      const metadata = job.metadata ?? (rec.safeMetadata as unknown as UploadMetadata);
      const s = await withRetry(job, g, () =>
        api.create({ category: job.category, fileName: file.name, fileSize: file.size, mimeType: rec.fingerprint.type, metadata }, rec.clientKey),
      );
      if (!isUsableChunkSize(s.chunkSize) || s.partCount !== partCount(file.size, s.chunkSize)) {
        throw new Failure('unknown', undefined, new Error(`Unusable upload session (chunkSize ${s.chunkSize}, ${s.partCount} parts)`));
      }
      job.metadata = null; // the server has the personal data now; the browser lets go of it (§8.2)
      job.displayName = s.displayName || job.displayName;
      let confirmed = bitsetNew(s.partCount);
      for (const n of rangesToParts(s.receivedRanges)) confirmed = bitsetSet(confirmed, n);
      job.rec = {
        ...rec,
        uploadId: s.uploadId,
        chunkSize: s.chunkSize,
        partCount: s.partCount,
        confirmed,
        displayName: job.displayName,
        // POST /uploads is authoritative and frozen for the life of the upload (§5, beat 7).
        policy: rec.policy && { ...rec.policy, version: s.policyVersion, chunkSize: s.chunkSize, maxParallel: s.maxParallel, maxFileSize: s.maxFileSize },
      };
      persist(job);
      changed(job);
    }
    const rec = job.rec;
    if (!rec.fileSha256 || !rec.partSha256) {
      job.hashedBytes = 0;
      const out = await hasher
        .hash(
          file,
          rec.chunkSize!,
          (bytes) => {
            if (job.gen !== g) return;
            job.hashedBytes = bytes;
            changed(job);
          },
          job.ac.signal,
        )
        .catch((error: unknown) => {
          throw isAbort(error) ? new Stale() : new Failure('file_changed', undefined, error);
        });
      guard(job, g);
      if (out.partHashes.length !== rec.partCount) throw new Failure('unknown', undefined, new Error('Part hashes do not match the session'));
      job.rec = { ...job.rec, fileSha256: out.sha256, partSha256: out.partHashes };
      persist(job);
    }
    fire(job, { type: 'HASH_DONE' });
  }

  /** `uploading`: hand the unconfirmed parts to the scheduler (one per job, reused across runs). */
  function startParts(job: Job): void {
    const rec = job.rec!;
    job.scheduler ??= createScheduler({ transport, net, clock, rng, onSignal: (s) => onSignal(job, s) });
    job.scheduler.start({
      uploadId: rec.uploadId!,
      file: job.file!,
      chunkSize: rec.chunkSize!,
      partCount: rec.partCount!,
      partHashes: rec.partSha256!,
      isConfirmed: (n) => bitsetHas(job.rec!.confirmed, n),
      maxParallel: rec.policy?.maxParallel ?? 2,
    });
  }

  function onSignal(job: Job, s: SchedulerSignal): void {
    switch (s.type) {
      case 'part_started':
        job.inFlight.set(s.n, 0);
        job.retrying.delete(s.n);
        if (job.state === 'connection_lost') fire(job, { type: 'RETRY_FIRES' });
        else changed(job);
        return;
      case 'part_progress':
        job.inFlight.set(s.n, s.sent);
        changed(job);
        return;
      case 'part_ok':
        job.inFlight.delete(s.n);
        job.retrying.delete(s.n);
        job.error = undefined;
        job.reconciles = 0;
        job.rec = { ...job.rec!, confirmed: bitsetSet(job.rec!.confirmed, s.n) };
        persist(job);
        if (job.state === 'connection_lost') fire(job, { type: 'PART_OK' });
        else changed(job);
        return;
      case 'part_retry':
        job.inFlight.delete(s.n);
        job.retrying.add(s.n);
        job.error = errorView(s.error);
        changed(job);
        return;
      case 'waiting':
        job.retryAt = s.retryAt;
        job.offline = false;
        fire(job, { type: 'RETRY_SCHEDULED' });
        return;
      case 'offline':
        job.inFlight.clear();
        job.offline = true;
        job.retryAt = undefined;
        fire(job, { type: 'OFFLINE' });
        return;
      case 'online':
        fire(job, { type: 'ONLINE_CONFIRMED' });
        return;
      case 'all_done':
        if (fire(job, { type: 'ALL_PARTS_OK' }) === 'verifying') void run(job);
        return;
      case 'session':
        pauseJob(job, 'session');
        return;
      case 'reconcile':
        void reconcile(job);
        return;
      case 'fatal':
        fail(job, s.reason, s.error);
        return;
    }
  }

  /** `verifying`: POST complete with the client hash; a 202 is polled through GET /uploads/{id} (§13, §17.4). */
  async function verify(job: Job, g: number): Promise<void> {
    const rec = job.rec!;
    const uploadId = rec.uploadId!;
    try {
      for (;;) {
        const out = await withRetry(job, g, () => api.complete(uploadId, rec.fileSha256!, rec.partCount!));
        if (out.kind === 'done') return settle(job, out.result);
        fire(job, { type: 'COMPLETE_PENDING' });
        await sleep(job, out.retryAfterMs);
        for (;;) {
          const st = await withRetry(job, g, () => api.status(uploadId));
          if (st.result) return settle(job, st.result);
          if (st.status === 'open') break; // the server is waiting for complete again
          if (st.status !== 'verifying') throw new Failure('upload_gone');
          await sleep(job, POLL_MS);
        }
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'PARTS_MISSING') throw error;
      guard(job, g);
      partsMissing(job, rangesToParts(errorBody(error)?.missingRanges ?? []));
    }
  }

  /** 409 PARTS_MISSING: forget those parts and send them again. */
  function partsMissing(job: Job, missing: number[]): void {
    const rec = job.rec!;
    const gone = new Set(missing);
    let confirmed = bitsetNew(rec.partCount!);
    for (let n = 1; n <= rec.partCount!; n++) if (bitsetHas(rec.confirmed, n) && !gone.has(n)) confirmed = bitsetSet(confirmed, n);
    job.rec = { ...rec, confirmed };
    persist(job);
    if (fire(job, { type: 'PARTS_MISSING' }) === 'uploading') startParts(job);
  }

  function settle(job: Job, result: CompleteResult): void {
    job.result = result;
    fire(job, { type: 'COMPLETE_MATCH' });
    repo.remove(job.id).catch(noop); // nothing left to resume
  }

  /** 409 on a part or on complete: ask the server where the upload really is, never retry blindly (§6). */
  async function reconcile(job: Job): Promise<void> {
    const g = supersede(job);
    const uploadId = job.rec?.uploadId;
    if (!uploadId || ++job.reconciles > MAX_RECONCILES) return fail(job, 'upload_gone');
    try {
      const st = await withRetry(job, g, () => api.status(uploadId));
      if (st.result) return settle(job, st.result);
      if (st.status === 'verifying') {
        if (job.state !== 'verifying') fire(job, { type: 'ALL_PARTS_OK' });
        if (job.state === 'verifying') void run(job);
        return;
      }
      if (st.status !== 'open') return fail(job, 'upload_gone');
      // The server is the source of truth for received parts.
      const received = new Set(rangesToParts(st.receivedRanges));
      const missing = Array.from({ length: job.rec!.partCount! }, (_, i) => i + 1).filter((n) => !received.has(n));
      job.rec = { ...job.rec!, confirmed: [...received].reduce(bitsetSet, bitsetNew(job.rec!.partCount!)) };
      if (job.state === 'verifying') return partsMissing(job, missing);
      persist(job);
      startParts(job);
    } catch (error) {
      if (job.gen === g) onError(job, error);
    }
  }

  function resumeJob(job: Job): void {
    if (job.state === 'paused') {
      if (!job.file) {
        fire(job, { type: 'FILE_MISSING' });
        return;
      }
      fire(job, { type: 'RESUME', to: phase(job) });
      void run(job);
      return;
    }
    if (job.state === 'failed' && job.failReason && RESUMABLE.includes(job.failReason) && job.file) {
      job.reconciles = 0;
      fire(job, { type: 'RETRY', to: phase(job) });
      void run(job);
    }
  }

  function fromRecord(rec: PersistedUpload): Job {
    return {
      id: rec.localId,
      clientKey: rec.clientKey,
      userId: rec.userId,
      role: rec.startedByRole,
      category: rec.category,
      size: rec.fingerprint.size,
      displayName: rec.displayName,
      createdAt: rec.createdAt,
      state: rec.state,
      pauseReason: rec.pauseReason,
      failReason: rec.failReason,
      rec,
      file: null,
      handle: null,
      metadata: null,
      result: null,
      error: rec.failReason ? { code: rec.failReason.toUpperCase(), message: ro.upload.failure[rec.failReason] } : undefined,
      hashedBytes: 0,
      inFlight: new Map(),
      retrying: new Set(),
      retryAt: undefined,
      offline: false,
      speed: createSpeedMeter(),
      scheduler: null,
      ac: new AbortController(),
      gen: 0,
      reconciles: 0,
    };
  }

  /** Same size, last-modified time and name (§8.4 steps 1–2). */
  async function isSameFile(rec: PersistedUpload, file: File): Promise<boolean> {
    const fp = rec.fingerprint;
    if (file.size !== fp.size || file.lastModified !== fp.lastModified) return false;
    return (await deps.sha256Text(file.name)) === fp.nameHash;
  }

  // ---- commands --------------------------------------------------------------------------------------------

  const engine: UploadEngine = {
    enqueue({ file, category, metadata, handle }) {
      if (owner === null) throw new Error('uploadEngine.restore(userId) must run before enqueue');
      const job: Job = {
        id: deps.newId(),
        clientKey: deps.newId(),
        userId: owner,
        role: null,
        category,
        size: file.size,
        // A connection document's file name may contain personal data ("CI_Popescu_Ion.pdf"): never shown.
        displayName: metadata.kind === 'connection' ? ro.upload.connectionLabel(metadata.requestNumber) : file.name,
        createdAt: clock.now(),
        state: 'queued',
        rec: null,
        file,
        handle: handle ?? null,
        metadata,
        result: null,
        error: undefined,
        hashedBytes: 0,
        inFlight: new Map(),
        retrying: new Set(),
        retryAt: undefined,
        offline: false,
        speed: createSpeedMeter(),
        scheduler: null,
        ac: new AbortController(),
        gen: 0,
        reconciles: 0,
      };
      jobs.set(job.id, job);
      changed(job);
      queueMicrotask(pumpQueue); // the caller sees the row `queued` first
      return job.id;
    },

    pause(id) {
      const job = jobs.get(id);
      if (job && RUNNING.includes(job.state)) pauseJob(job, 'user');
    },

    resume(id) {
      const job = jobs.get(id);
      if (job) resumeJob(job);
    },

    async cancel(id) {
      const job = jobs.get(id);
      if (!job) return;
      supersede(job);
      jobs.delete(id);
      changed(job);
      queueMicrotask(pumpQueue);
      const uploadId = job.rec?.uploadId;
      // Both are best effort: an unreachable server drops the session itself after 24 h without parts.
      await Promise.all([
        uploadId && job.state !== 'verified' ? api.cancel(uploadId).catch(noop) : null,
        repo.remove(id).catch(noop),
      ]);
    },

    async reattach(id, file) {
      const job = jobs.get(id);
      const attachable = job?.state === 'needs_file' || (job?.state === 'failed' && job.failReason === 'different_file');
      if (!job?.rec || !attachable) return;
      const g = supersede(job);
      const same = await isSameFile(job.rec, file).catch(() => false);
      if (job.gen !== g || jobs.get(id) !== job) return;
      if (!same) return fail(job, 'different_file');
      job.file = file;
      fire(job, { type: 'FILE_ATTACHED', to: phase(job) });
      void run(job);
    },

    pauseAll(reason) {
      for (const job of jobs.values()) if (RUNNING.includes(job.state)) pauseJob(job, reason);
    },

    resumeAll(ownerUserId) {
      for (const job of jobs.values()) {
        if (job.userId === ownerUserId && job.state === 'paused' && (job.pauseReason === 'session' || job.pauseReason === 'logout')) resumeJob(job);
      }
      pumpQueue();
    },

    async restore(userId) {
      owner = userId;
      // Another account's uploads stop and disappear from view; they wait for their owner (Review Focus 2).
      for (const job of jobs.values()) if (job.userId !== userId && RUNNING.includes(job.state)) pauseJob(job, 'session');
      rebuild();
      await repo.purgeOlderThan(RECORD_TTL_MS).catch(noop);
      const records = await repo.listFor(userId).catch((): PersistedUpload[] => []);
      if (owner !== userId) return; // a newer restore owns the view
      for (const rec of records) {
        if (jobs.has(rec.localId)) continue;
        if (rec.state === 'verified') {
          repo.remove(rec.localId).catch(noop);
          continue;
        }
        const job = fromRecord(rec);
        jobs.set(job.id, job);
        // A reloaded upload never jumps straight back to `uploading`; without its file it waits for the user.
        if (fire(job, { type: 'RESTORE' }) === 'queued') fire(job, { type: 'FILE_MISSING' });
      }
      rebuild();
    },

    async restoreAndResume(userId) {
      await engine.restore(userId);
      engine.resumeAll(userId);
    },
  };
  return engine;
}

// ---- the module singleton --------------------------------------------------------------------------------

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function browserDeps(): EngineDeps {
  const rng = Math.random;
  return {
    api: createUploadApi(),
    transport: createXhrTransport(),
    hasher: createWorkerHasher(),
    repo: createRepo(),
    net: createNetMonitor({ win: window, probe: createPingProbe(), rng, clock: realClock }),
    clock: realClock,
    rng,
    whoami: async () => {
      const me = await unwrap(apiClient.GET('/auth/me'));
      return { userId: me.realUser.id, role: me.activeRole };
    },
    newId: () => crypto.randomUUID(),
    sha256Text: async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  };
}

let instance: UploadEngine | null = null;
const real = (): UploadEngine => (instance ??= createUploadEngine(browserDeps()));

/**
 * The engine of the app: one per tab, so it survives (app) → /login → (app). Built on first use (in the browser,
 * from an effect or a click), so importing it on the server creates no worker, database or listener.
 */
export const uploadEngine: UploadEngine = {
  enqueue: (input) => real().enqueue(input),
  pause: (id) => real().pause(id),
  resume: (id) => real().resume(id),
  cancel: (id) => real().cancel(id),
  reattach: (id, file) => real().reattach(id, file),
  pauseAll: (reason) => real().pauseAll(reason),
  resumeAll: (ownerUserId) => real().resumeAll(ownerUserId),
  restore: (userId) => real().restore(userId),
  restoreAndResume: (userId) => real().restoreAndResume(userId),
};
