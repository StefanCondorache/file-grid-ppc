import { ApiError } from '@/lib/api/errors';
import { ro } from '@/lib/i18n/ro';
import { errorBody, type PartTransport, type UploadApi } from './api';
import { backoffMs } from './backoff';
import { rangesToParts, type CompleteResult, type UploadMetadata, type UploadSession, type UploadStatus } from './contract';
import { confirmedBytes, inflightBytes, phaseOf, toView, type Item } from './engine-item';
import type { UploadControl } from './engine-port';
import type { HashClient } from './hasher';
import { transition } from './machine';
import type { NetMonitor } from './net';
import { persistableHandle, safeMetadata, toPersistable } from './pii';
import { effectiveMime, isUsableChunkSize } from './plan';
import { createRateTracker, createThrottle } from './progress';
import { bitsetClear, bitsetHas, bitsetNew, bitsetSet, type UploadRepo } from './repo';
import { classifyError, createScheduler, isAbort, MAX_ATTEMPTS, type SchedulerSignal } from './scheduler';
import type { UploadItemView } from './store';
import type { Clock, FailReason, PauseReason, PolicySnapshot, ResumePhase, Role, UploadCategoryId, UploadEvent, UploadState } from './types';

export interface EngineDeps {
  api: UploadApi;
  transport: PartTransport;
  repo: UploadRepo;
  hasher: HashClient;
  net: NetMonitor;
  clock: Clock;
  rng: () => number;
  publish(views: readonly UploadItemView[]): void;
  /** A 401 reached an upload: the app ends the session (the queue is kept and resumes after re-login). */
  onSessionExpired?(error: ApiError): void;
  onCompleted?(view: UploadItemView): void;
  /** Reopens a stored FileSystemFileHandle (file-handle.ts); absent where handles are not supported. */
  reopen?(handle: unknown, interactive: boolean): Promise<File | 'needs_permission' | null>;
  newId?(): string;
  log?(message: string, error: unknown): void;
}

export interface EnqueueInput {
  file: File;
  category: UploadCategoryId;
  metadata: UploadMetadata;
  owner: { id: string; role: Role };
  handle?: unknown;
}

const ACTIVE: readonly UploadState[] = ['hashing', 'uploading', 'connection_lost', 'verifying'];
/** Client-side bulkhead: a burst of drone videos never starves fault records (N1). */
export const MAX_ACTIVE_PER_CATEGORY = 2;
const MAX_HASHING = 2;
const PUBLISH_MS = 250;
const POLL_MS = 2000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isReadError(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
  return name === 'NotReadableError' || name === 'NotFoundError';
}

/** First, middle and last part: re-hashed to check a re-attached file is the one started (upload-engine.md §8.4). */
function sampleSet(partCount: number): number[] {
  return [...new Set([1, Math.ceil(partCount / 2), partCount])];
}

/**
 * The upload engine (upload-engine.md §4, FA-24): framework-free, a module singleton in the app, unit-tested with
 * fake ports. Flow per file: queued → hashing (POST /uploads first: the server fixes the part size, then the
 * hash-first pass) → uploading (scheduler) → verifying (complete, 202 polling) → verified | failed.
 */
export function createUploadEngine(deps: EngineDeps) {
  const { api, repo, hasher, net, clock, rng } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((m: string, e: unknown) => console.error(`[upload] ${m}`, e));
  const items = new Map<string, Item>();
  let currentUser: string | null = null;
  let sessionNotified = false;

  const throttle = createThrottle(() => deps.publish(views()), PUBLISH_MS, clock);

  function views(): UploadItemView[] {
    return [...items.values()].filter((i) => i.rec.userId === currentUser).map(toView);
  }

  function persist(item: Item): void {
    const input = { ...item.rec, state: item.state, pauseReason: item.pauseReason ?? undefined, failReason: item.failReason ?? undefined, updatedAt: clock.now() };
    const rec = toPersistable(
      { ...input, fileName: item.fileName, nameHash: item.rec.fingerprint.nameHash, size: item.rec.fingerprint.size, lastModified: item.rec.fingerprint.lastModified, type: item.rec.fingerprint.type, metadata: item.rec.safeMetadata },
      item.rec.category,
    );
    repo.put(rec).catch((e) => log('could not persist an upload record', e));
  }

  function fire(item: Item, event: UploadEvent): void {
    const next = transition(item.state, event);
    if (next === item.state) return;
    item.state = next;
    if (event.type === 'PAUSE') item.pauseReason = event.reason;
    if (event.type === 'FAIL') item.failReason = event.reason;
    if (next !== 'connection_lost') item.retryAt = null;
    if (next !== 'connection_lost' && next !== 'hashing') item.offline = false;
    item.tracker.reset(confirmedBytes(item.rec) + inflightBytes(item));
    throttle.flush();
  }

  /** Stops every piece of running work for the item; later async results of that run are ignored. */
  function stopWork(item: Item): void {
    item.run++;
    item.scheduler?.stop();
    item.scheduler = null;
    item.abort?.abort();
    item.abort = null;
    if (item.timer !== null) clock.clearTimeout(item.timer);
    item.timer = null;
    item.unsubscribeNet?.();
    item.unsubscribeNet = null;
    item.inflight.clear();
    item.retrying.clear();
  }

  const live = (item: Item, run: number) => items.get(item.rec.localId) === item && item.run === run;

  function admit(): void {
    const all = [...items.values()];
    for (const item of all) {
      if (item.state !== 'queued' || !item.file || item.rec.userId !== currentUser) continue;
      const sameCategory = all.filter((i) => i.rec.category === item.rec.category && ACTIVE.includes(i.state)).length;
      const hashing = all.filter((i) => i.state === 'hashing').length;
      if (sameCategory >= MAX_ACTIVE_PER_CATEGORY || hashing >= MAX_HASHING) continue;
      fire(item, { type: 'SLOT_FREE' });
      begin(item, 'hashing');
    }
  }

  function begin(item: Item, phase: ResumePhase): void {
    stopWork(item);
    const run = item.run;
    if (phase === 'hashing') void prepare(item, run);
    else if (phase === 'verifying') void complete(item, run, 0);
    else void syncAndUpload(item, run);
  }

  function fail(item: Item, reason: FailReason, error: unknown = null): void {
    stopWork(item);
    item.lastError = error;
    fire(item, { type: 'FAIL', reason });
    // Only a resumable failure or a wrong re-attached file can continue later; the rest has nothing to resume.
    if (reason === 'retries_exhausted' || reason === 'different_file') persist(item);
    else repo.remove(item.rec.localId).catch((e) => log('could not remove an upload record', e));
    admit();
  }

  function pauseFor(item: Item, reason: PauseReason, phase: ResumePhase): void {
    stopWork(item);
    item.resumeTo = phase;
    fire(item, { type: 'PAUSE', reason });
    persist(item);
  }

  function sessionPause(item: Item, phase: ResumePhase, error: ApiError): void {
    pauseFor(item, 'session', phase);
    if (!sessionNotified) {
      sessionNotified = true;
      deps.onSessionExpired?.(error);
    }
    admit();
  }

  /** Retry a JSON step (create, complete, poll) later: on the network's return, or after a backoff while online. */
  function later(item: Item, run: number, attempt: number, error: unknown, again: () => void): void {
    if (!net.online) {
      item.offline = true;
      if (item.state !== 'hashing') fire(item, { type: 'OFFLINE' });
      throttle.flush();
      item.unsubscribeNet = net.subscribe((online) => {
        if (!online || !live(item, run)) return;
        item.unsubscribeNet?.();
        item.unsubscribeNet = null;
        item.offline = false;
        if (item.state === 'connection_lost') fire(item, { type: 'ONLINE_CONFIRMED' });
        again();
      });
      return;
    }
    if (attempt + 1 >= MAX_ATTEMPTS) return fail(item, 'retries_exhausted', error);
    const hinted = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
    item.timer = clock.setTimeout(() => live(item, run) && again(), Math.max(backoffMs(attempt, rng), hinted));
  }

  /** Classified handling shared by the JSON steps; returns true when the error was dealt with. */
  function jsonError(item: Item, run: number, phase: ResumePhase, error: unknown, attempt: number, again: () => void): void {
    if (!live(item, run) || isAbort(error)) return;
    const c = classifyError(error);
    item.lastError = error;
    if (c.kind === 'session') return sessionPause(item, phase, error as ApiError);
    if (c.kind === 'retry') return later(item, run, attempt, error, again);
    if (c.kind === 'reconcile' && item.rec.uploadId) return void reconcile(item, run);
    if (c.kind === 'fatal') return fail(item, c.reason, error);
    fail(item, 'unknown', error);
  }

  function adoptSession(item: Item, s: UploadSession): boolean {
    if (!isUsableChunkSize(s.chunkSize) || s.partCount !== Math.ceil(item.rec.fingerprint.size / s.chunkSize)) {
      fail(item, 'policy_violation', new ApiError(0, 'BAD_RESPONSE', `Unusable part size ${s.chunkSize}`));
      return false;
    }
    const policy: PolicySnapshot = {
      ...(item.rec.policy ?? { category: item.rec.category, primaryStorage: 's3', fallbackStorage: null, encryptionAtRest: false, allowedTypes: [] }),
      version: s.policyVersion,
      chunkSize: s.chunkSize,
      maxParallel: s.maxParallel,
      maxFileSize: s.maxFileSize,
    };
    let confirmed = bitsetNew(s.partCount);
    for (const n of rangesToParts(s.receivedRanges)) confirmed = bitsetSet(confirmed, n);
    item.rec = { ...item.rec, uploadId: s.uploadId, chunkSize: s.chunkSize, partCount: s.partCount, policy, displayName: s.displayName, confirmed };
    item.pii = null; // personal data is with the server now; drop the in-memory copy (ADR-0013)
    persist(item);
    return true;
  }

  async function prepare(item: Item, run: number, attempt = 0): Promise<void> {
    try {
      if (!item.rec.uploadId) {
        if (!item.pii) {
          item.extraMessage = ro.upload.metadataLost;
          return fail(item, 'unknown');
        }
        const session = await api.create(
          { category: item.rec.category, fileName: item.fileName, fileSize: item.rec.fingerprint.size, mimeType: effectiveMime({ type: item.rec.fingerprint.type }), metadata: item.pii },
          item.rec.clientKey,
        );
        if (!live(item, run) || !adoptSession(item, session)) return;
        throttle.flush();
      }
      if (!item.rec.partSha256) {
        const ac = new AbortController();
        item.abort = ac;
        const { sha256, partHashes } = await hasher.hash(item.file!, item.rec.chunkSize!, (b) => {
          item.hashedBytes = b;
          throttle.schedule();
        }, ac.signal);
        if (!live(item, run)) return;
        if (partHashes.length !== item.rec.partCount) return fail(item, 'file_changed');
        item.rec = { ...item.rec, fileSha256: sha256, partSha256: partHashes };
        persist(item);
      }
      fire(item, { type: 'HASH_DONE' });
      startScheduler(item, run);
    } catch (error) {
      if (!live(item, run) || isAbort(error)) return;
      if (error instanceof ApiError) return jsonError(item, run, 'hashing', error, attempt, () => void prepare(item, run, attempt + 1));
      // A failed read means the file changed or vanished on disk; anything else is a worker failure.
      fail(item, isReadError(error) ? 'file_changed' : 'unknown', error);
    }
  }

  /** Merges the server's received parts (the resume source of truth) before sending again. */
  async function syncAndUpload(item: Item, run: number, attempt = 0): Promise<void> {
    try {
      const st = await api.status(item.rec.uploadId!);
      if (!live(item, run)) return;
      if (st.status !== 'open') return adoptStatus(item, run, st);
      let confirmed = item.rec.confirmed;
      for (const n of rangesToParts(st.receivedRanges)) confirmed = bitsetSet(confirmed, n);
      item.rec = { ...item.rec, confirmed };
      if (item.state !== 'uploading') fire(item, { type: 'ONLINE_CONFIRMED' });
      startScheduler(item, run);
    } catch (error) {
      jsonError(item, run, 'uploading', error, attempt, () => void syncAndUpload(item, run, attempt + 1));
    }
  }

  function startScheduler(item: Item, run: number): void {
    const { rec } = item;
    const scheduler = createScheduler({ transport: deps.transport, net, clock, rng, onSignal: (s) => live(item, run) && onSignal(item, run, s) });
    item.scheduler = scheduler;
    item.tracker.reset(confirmedBytes(rec));
    scheduler.start({
      uploadId: rec.uploadId!,
      file: item.file!,
      chunkSize: rec.chunkSize!,
      partCount: rec.partCount!,
      partHashes: rec.partSha256!,
      isConfirmed: (n) => bitsetHas(item.rec.confirmed, n),
      maxParallel: rec.policy?.maxParallel ?? 2,
    });
  }

  function onSignal(item: Item, run: number, s: SchedulerSignal): void {
    switch (s.type) {
      case 'part_started':
        item.inflight.set(s.n, 0);
        item.retrying.delete(s.n);
        if (item.state === 'connection_lost') fire(item, { type: 'RETRY_FIRES' });
        return throttle.schedule();
      case 'part_progress':
        item.inflight.set(s.n, s.sent);
        item.tracker.sample(confirmedBytes(item.rec) + inflightBytes(item));
        return throttle.schedule();
      case 'part_ok':
        item.inflight.delete(s.n);
        item.rec = { ...item.rec, confirmed: bitsetSet(item.rec.confirmed, s.n) };
        item.lastError = null;
        repo.markPart(item.rec.localId, s.n).catch((e) => log('could not record a confirmed part', e));
        fire(item, { type: 'PART_OK' });
        return throttle.schedule();
      case 'part_retry':
        item.inflight.delete(s.n);
        item.retrying.add(s.n);
        item.retries++;
        item.lastError = s.error;
        return throttle.flush();
      case 'waiting':
        item.retryAt = s.retryAt;
        fire(item, { type: 'RETRY_SCHEDULED' });
        return throttle.flush();
      case 'offline':
        item.inflight.clear();
        item.offline = true;
        fire(item, { type: 'OFFLINE' });
        return throttle.flush();
      case 'online':
        item.offline = false;
        fire(item, { type: 'ONLINE_CONFIRMED' });
        return throttle.flush();
      case 'all_done':
        item.inflight.clear();
        item.retrying.clear();
        fire(item, { type: 'ALL_PARTS_OK' });
        void complete(item, run, 0);
        return;
      case 'session':
        return sessionPause(item, 'uploading', s.error);
      case 'reconcile':
        return void reconcile(item, run);
      case 'fatal':
        return fail(item, s.reason, s.error);
    }
  }

  async function complete(item: Item, run: number, attempt: number): Promise<void> {
    const { rec } = item;
    try {
      const out = await api.complete(rec.uploadId!, rec.fileSha256!, rec.partCount!);
      if (!live(item, run)) return;
      if (out.kind === 'done') return finish(item, out.result);
      fire(item, { type: 'COMPLETE_PENDING' });
      item.timer = clock.setTimeout(() => live(item, run) && void poll(item, run, 0), out.retryAfterMs);
    } catch (error) {
      if (!live(item, run)) return;
      const missing = errorBody(error)?.missingRanges;
      if (error instanceof ApiError && error.status === 409 && missing) return resendMissing(item, run, rangesToParts(missing));
      jsonError(item, run, 'verifying', error, attempt, () => void complete(item, run, attempt + 1));
    }
  }

  function resendMissing(item: Item, run: number, missing: number[]): void {
    let confirmed = item.rec.confirmed;
    for (const n of missing) confirmed = bitsetClear(confirmed, n);
    item.rec = { ...item.rec, confirmed };
    persist(item);
    fire(item, { type: 'PARTS_MISSING' });
    startScheduler(item, run);
  }

  async function poll(item: Item, run: number, attempt: number): Promise<void> {
    try {
      const st = await api.status(item.rec.uploadId!);
      if (!live(item, run)) return;
      if (st.status === 'verifying') {
        item.timer = clock.setTimeout(() => live(item, run) && void poll(item, run, 0), POLL_MS);
        return;
      }
      // `open` again: the server's assembly failed and was reopened; complete again (it reports missing parts).
      if (st.status === 'open') return void complete(item, run, attempt);
      adoptStatus(item, run, st);
    } catch (error) {
      jsonError(item, run, 'verifying', error, attempt, () => void poll(item, run, attempt + 1));
    }
  }

  function adoptStatus(item: Item, run: number, st: UploadStatus): void {
    if (st.result && (st.status === 'completed' || st.status === 'failed')) return finish(item, st.result);
    if (st.status === 'verifying') {
      if (item.state === 'uploading' || item.state === 'connection_lost') fire(item, { type: 'ALL_PARTS_OK' });
      item.timer = clock.setTimeout(() => live(item, run) && void poll(item, run, 0), POLL_MS);
      return;
    }
    if (st.status === 'open') return void syncAndUpload(item, run);
    fail(item, 'upload_gone');
  }

  /** 409 on a part (UPLOAD_NOT_OPEN / UPLOAD_COMPLETED): never retried blindly, the server state decides. */
  async function reconcile(item: Item, run: number): Promise<void> {
    item.scheduler?.stop();
    try {
      const st = await api.status(item.rec.uploadId!);
      if (live(item, run)) adoptStatus(item, run, st);
    } catch (error) {
      jsonError(item, run, 'uploading', error, 0, () => void reconcile(item, run));
    }
  }

  function finish(item: Item, result: CompleteResult): void {
    stopWork(item);
    item.result = result;
    if (result.verdict !== 'match' || !result.fileId) return fail(item, 'checksum_mismatch');
    fire(item, { type: 'COMPLETE_MATCH' });
    repo.remove(item.rec.localId).catch((e) => log('could not remove a verified upload record', e));
    deps.onCompleted?.(toView(item));
    admit();
  }

  function newItem(rec: Item['rec'], file: File | null, fileName: string, pii: UploadMetadata | null, handle: unknown): Item {
    return {
      rec, file, handle, fileName, pii, state: rec.state, pauseReason: rec.pauseReason ?? null, failReason: rec.failReason ?? null,
      resumeTo: 'hashing', hashedBytes: 0, inflight: new Map(), retrying: new Set(), retries: 0, retryAt: null, offline: false,
      lastError: null, result: null, needsPermission: false, run: 0, scheduler: null, abort: null, timer: null, unsubscribeNet: null,
      tracker: createRateTracker(clock), extraMessage: null,
    };
  }

  function enqueue(input: EnqueueInput): string {
    const { file, category, metadata, owner } = input;
    const localId = newId();
    currentUser = owner.id;
    const displayName = category === 'connection_documents' && metadata.kind === 'connection' ? `Document racordare nr. ${metadata.requestNumber}` : file.name;
    const now = clock.now();
    const rec: Item['rec'] = {
      localId, userId: owner.id, startedByRole: owner.role, clientKey: newId(), uploadId: null, category, state: 'queued',
      fingerprint: { nameHash: '', size: file.size, lastModified: file.lastModified, type: file.type },
      policy: null, chunkSize: null, partCount: null, confirmed: bitsetNew(0), safeMetadata: safeMetadata(category, metadata),
      displayName, createdAt: now, updatedAt: now,
    };
    const item = newItem(rec, file, file.name, metadata, input.handle ?? null);
    items.set(localId, item);
    // The Idempotency-Key and the record are written before POST /uploads (UE-15).
    void sha256Hex(file.name).then((nameHash) => {
      item.rec = { ...item.rec, fingerprint: { ...item.rec.fingerprint, nameHash } };
      persist(item);
      const handle = persistableHandle(category, input.handle);
      if (handle) repo.putHandle(localId, handle).catch((e) => log('could not store a file handle', e));
    }).catch((e) => log('could not fingerprint the file name', e));
    throttle.flush();
    admit();
    return localId;
  }

  async function reattach(id: string, file: File, handle?: unknown): Promise<'ok' | 'different_file'> {
    const item = items.get(id);
    if (!item || !(item.state === 'needs_file' || (item.state === 'failed' && item.failReason === 'different_file'))) return 'different_file';
    const { rec } = item;
    const fp = rec.fingerprint;
    const sameName = fp.name !== undefined ? file.name === fp.name : (await sha256Hex(file.name)) === fp.nameHash;
    let same = sameName && file.size === fp.size;
    if (same && rec.partSha256 && rec.chunkSize && rec.partCount) {
      const parts = sampleSet(rec.partCount);
      const hashes = await hasher.sample(file, rec.chunkSize, parts);
      same = parts.every((n) => hashes[n] === rec.partSha256![n - 1]);
    }
    if (!same) {
      fail(item, 'different_file');
      return 'different_file';
    }
    item.file = file;
    item.fileName = file.name;
    item.needsPermission = false;
    const keep = persistableHandle(rec.category, handle ?? item.handle);
    if (keep) {
      item.handle = keep;
      repo.putHandle(id, keep).catch((e) => log('could not store a file handle', e));
    }
    const to = phaseOf(item);
    item.failReason = null;
    fire(item, { type: 'FILE_ATTACHED', to });
    begin(item, to);
    return 'ok';
  }

  async function restore(userId: string): Promise<void> {
    currentUser = userId;
    await repo.purgeOlderThan(RECORD_TTL_MS).catch((e) => log('could not purge old upload records', e));
    const records = await repo.listFor(userId).catch((e) => {
      log('could not read upload records', e);
      return [];
    });
    for (const rec of records) {
      if (items.has(rec.localId) || rec.state === 'verified') continue;
      const item = newItem(rec, null, rec.fingerprint.name ?? '', rec.category === 'connection_documents' ? null : (rec.safeMetadata as unknown as UploadMetadata), null);
      // A persisted failure is resumable (retries exhausted) or a wrong file: both continue once the file is back.
      item.state = transition(rec.state === 'failed' ? 'queued' : rec.state, { type: 'RESTORE' });
      items.set(rec.localId, item);
      if (item.state === 'queued') fire(item, { type: 'FILE_MISSING' });
    }
    throttle.flush();
  }

  function pause(id: string): void {
    const item = items.get(id);
    if (!item || !(item.state === 'queued' || ACTIVE.includes(item.state))) return;
    pauseFor(item, 'user', phaseOf(item));
    admit();
  }

  function resumeAll(ownerUserId: string): void {
    currentUser = ownerUserId;
    sessionNotified = false;
    for (const item of items.values()) {
      if (item.rec.userId === ownerUserId && item.state === 'paused' && (item.pauseReason === 'session' || item.pauseReason === 'logout')) resume(item.rec.localId);
    }
    admit();
    throttle.flush();
  }

  function resume(id: string): void {
    const item = items.get(id);
    if (!item || item.state !== 'paused') return;
    if (!item.file) return fire(item, { type: 'FILE_MISSING' });
    const to = item.resumeTo === 'hashing' ? phaseOf(item) : item.resumeTo;
    item.lastError = null;
    fire(item, { type: 'RESUME', to });
    begin(item, to);
  }

  return {
    enqueue,
    reattach,
    restore,
    pause,
    resume,
    retry(id: string): void {
      const item = items.get(id);
      if (!item || item.state !== 'failed' || item.failReason !== 'retries_exhausted') return;
      if (!item.file) return;
      const to = phaseOf(item);
      item.retries = 0;
      item.lastError = null;
      fire(item, { type: 'RETRY', to });
      begin(item, to);
    },
    async cancel(id: string): Promise<void> {
      const item = items.get(id);
      if (!item) return;
      stopWork(item);
      items.delete(id);
      throttle.flush();
      admit();
      await repo.remove(id).catch((e) => log('could not remove an upload record', e));
      if (item.rec.uploadId && item.state !== 'verified') {
        // Best effort: an unreachable server expires the session by itself after 24 h.
        await api.cancel(item.rec.uploadId).catch((e) => log('could not cancel the upload on the server', e));
      }
    },
    pauseAll(reason: 'session' | 'logout'): void {
      for (const item of items.values()) {
        if (item.state === 'queued' || ACTIVE.includes(item.state)) pauseFor(item, reason, phaseOf(item));
      }
    },
    resumeAll,
    async restoreAndResume(userId: string): Promise<void> {
      await restore(userId);
      resumeAll(userId);
    },
    views,
  } satisfies UploadControl & Record<string, unknown>;
}

export type UploadEngine = ReturnType<typeof createUploadEngine>;
