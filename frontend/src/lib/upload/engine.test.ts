import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { CompleteOutcome, PartSend, PartTransport, UploadApi } from './api';
import { partsToRanges, type CompleteResult, type DroneMetadata, type UploadSession } from './contract';
import { createUploadEngine, type EngineDeps } from './engine';
import type { HashClient } from './hasher';
import type { NetMonitor } from './net';
import type { UploadRepo } from './repo';
import { useUploadStore, type UploadItemView } from './store';
import { realClock, type PersistedUpload, type PolicySnapshot, type UploadCategoryId } from './types';

const MiB = 1024 * 1024;
const SIZE = 2.5 * MiB; // three parts of 1 MiB, the last one half
const drone: DroneMetadata = { kind: 'drone', lineSection: 'LEA 110 kV Reșița–Timișoara', zone: 'banat', inspectionDate: '2026-11-14' };

/** What the fake hasher "reads": files made from the same seed have the same bytes. */
const seeds = new WeakMap<Blob, string>();
function testFile(seed: string, name = 'inspectie-linia-7.mp4', lastModified = 1_763_100_000_000): File {
  const file = new File([new Uint8Array(SIZE)], name, { type: 'video/mp4', lastModified });
  seeds.set(file, seed);
  return file;
}
const seedOf = (b: Blob) => seeds.get(b) ?? 'unknown';
const partHash = (seed: string, n: number) => `${seed}:part-${n}`;

function fakeHasher(): HashClient & { sampled: number[][] } {
  const sampled: number[][] = [];
  return {
    sampled,
    async hash(file, chunkSize, onProgress) {
      onProgress(file.size);
      const parts = Math.ceil(file.size / chunkSize);
      return { sha256: `${seedOf(file)}:whole`, partHashes: Array.from({ length: parts }, (_, i) => partHash(seedOf(file), i + 1)) };
    },
    async sample(file, _chunkSize, parts) {
      sampled.push(parts);
      return Object.fromEntries(parts.map((n) => [n, partHash(seedOf(file), n)]));
    },
  };
}

const POLICY: PolicySnapshot = {
  category: 'drone_videos',
  version: 3,
  primaryStorage: 'ftp',
  fallbackStorage: 's3',
  encryptionAtRest: false,
  chunkSize: MiB,
  maxParallel: 2,
  maxFileSize: 4 * 1024 * MiB,
  allowedTypes: ['video/mp4'],
};

type ServerUpload = { key: string; size: number; partCount: number; received: Set<number> };

/** An in-memory backend: sessions survive a "reload" (a second engine on the same server and repo). */
function fakeServer(opts: { verdict?: 'match' | 'mismatch'; latencyMs?: number; transport?: PartTransport } = {}) {
  const uploads = new Map<string, ServerUpload>();
  const result = (uploadId: string, sha256: string): CompleteResult => {
    const match = (opts.verdict ?? 'match') === 'match';
    return {
      status: match ? 'completed' : 'failed',
      verdict: match ? 'match' : 'mismatch',
      fileId: match ? `file-of-${uploadId}` : null,
      clientSha256: sha256,
      serverSha256: match ? sha256 : 'f'.repeat(64),
      size: uploads.get(uploadId)!.size,
      storage: 'ftp',
      usedFallback: false,
      policyVersion: 3,
      encryptedAtRest: false,
      availableAt: null,
      availableAfterMs: null,
      traceId: 'trace-complete',
    };
  };
  const api = {
    policy: vi.fn(async (category: UploadCategoryId) => ({ ...POLICY, category })),
    create: vi.fn(async (req, key): Promise<UploadSession> => {
      let id = [...uploads].find(([, u]) => u.key === key)?.[0];
      if (!id) {
        id = `srv-${uploads.size + 1}`;
        uploads.set(id, { key, size: req.fileSize, partCount: Math.ceil(req.fileSize / MiB), received: new Set() });
      }
      const u = uploads.get(id)!;
      return {
        uploadId: id,
        status: 'open',
        chunkSize: MiB,
        partCount: u.partCount,
        maxParallel: 2,
        policyVersion: 3,
        maxFileSize: POLICY.maxFileSize,
        expiresAt: '2026-11-15T12:00:00Z',
        displayName: req.fileName,
        receivedRanges: partsToRanges([...u.received]),
      };
    }),
    status: vi.fn(async () => {
      throw new Error('not used');
    }),
    complete: vi.fn(async (uploadId: string, sha256: string): Promise<CompleteOutcome> => ({ kind: 'done', result: result(uploadId, sha256) })),
    cancel: vi.fn(async () => {}),
  } satisfies UploadApi;

  const calls: PartSend[] = [];
  const transport: PartTransport = opts.transport ?? {
    send(args) {
      calls.push(args);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          uploads.get(args.uploadId)!.received.add(args.partNumber);
          args.onProgress(args.body.size);
          resolve({ partNumber: args.partNumber, size: args.body.size, sha256: args.sha256Hex, alreadyReceived: false });
        }, opts.latencyMs ?? 100);
        args.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };
  return { api, transport, calls, uploads };
}

function memoryRepo(): UploadRepo & { records: Map<string, PersistedUpload> } {
  const records = new Map<string, PersistedUpload>();
  const handles = new Map<string, unknown>();
  return {
    records,
    put: async (r) => void records.set(r.localId, structuredClone(r)),
    get: async (id) => structuredClone(records.get(id)),
    listFor: async (userId) => [...records.values()].filter((r) => r.userId === userId).map((r) => structuredClone(r)),
    markPart: async () => {},
    remove: async (id) => {
      records.delete(id);
      handles.delete(id);
    },
    purgeOlderThan: async () => 0,
    putHandle: async (id, h) => void handles.set(id, h),
    getHandle: async (id) => handles.get(id),
  };
}

const onlineNet = (): NetMonitor => ({ online: true, subscribe: () => () => {}, reportNetworkError() {}, reportSuccess() {}, dispose() {} });

function setup(server = fakeServer(), repo = memoryRepo(), hasher = fakeHasher(), over: Partial<EngineDeps> = {}) {
  let n = 0;
  const deps: EngineDeps = {
    api: server.api,
    transport: server.transport,
    hasher,
    repo,
    net: onlineNet(),
    clock: realClock,
    rng: () => 0.5,
    whoami: async () => ({ userId: 'u1', role: 'teren' }),
    newId: () => `id-${++n}-${Math.random().toString(36).slice(2, 8)}`,
    sha256Text: async (text) => `sha256(${text})`,
    ...over,
  };
  return { engine: createUploadEngine(deps), server, repo, hasher };
}

const item = (id: string): UploadItemView => useUploadStore.getState().items[id]!;

/** Every distinct state the store showed for the only upload, in order. */
function trackStates() {
  const states: string[] = [];
  const stop = useUploadStore.subscribe((s) => {
    const state = Object.values(s.items)[0]?.state;
    if (state && states.at(-1) !== state) states.push(state);
  });
  return { states, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  useUploadStore.setState({ items: {} });
});
afterEach(() => vi.useRealTimers());

describe('upload engine facade', () => {
  it('runs enqueue → hashing → uploading → verifying → verified with fake ports', async () => {
    const { engine, server } = setup();
    await engine.restore('u1');
    const { states, stop } = trackStates();

    const id = engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    expect(item(id).state).toBe('queued');
    await vi.advanceTimersByTimeAsync(5000);
    stop();

    expect(states).toEqual(['queued', 'hashing', 'uploading', 'verifying', 'verified']);
    expect(item(id)).toMatchObject({
      state: 'verified',
      verdict: 'match',
      fileId: 'file-of-srv-1',
      ownerUserId: 'u1',
      startedAsRole: 'teren',
      partCount: 3,
      bytesConfirmed: SIZE,
      size: SIZE,
    });
    expect(item(id).serverSha256).toBe(item(id).clientSha256);
    expect(server.calls.map((c) => c.partNumber).sort()).toEqual([1, 2, 3]);
    expect(server.api.complete).toHaveBeenCalledWith('srv-1', 'A:whole', 3);
  });

  it('a hash mismatch ends in failed(checksum_mismatch) with no file id', async () => {
    const { engine, repo } = setup(fakeServer({ verdict: 'mismatch' }));
    await engine.restore('u1');

    const id = engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    await vi.advanceTimersByTimeAsync(5000);

    expect(item(id)).toMatchObject({
      state: 'failed',
      failReason: 'checksum_mismatch',
      verdict: 'mismatch',
      clientSha256: 'A:whole',
      serverSha256: 'f'.repeat(64),
      traceId: 'trace-complete',
      error: { message: 'Amprenta nu coincide. Fișierul nu a fost păstrat.' },
    });
    expect(item(id).fileId ?? null).toBeNull();
    // The failure survives a reload: the record stays, marked failed.
    expect(repo.records.get(id)).toMatchObject({ state: 'failed', failReason: 'checksum_mismatch' });
  });

  // Review Focus 1: reload, then the user picks a different file with the same name, size and date.
  it('rejects a reattached file whose sampled part hashes differ', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const hasher = fakeHasher();
    const before = setup(server, repo, hasher);
    await before.engine.restore('u1');
    const id = before.engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    await vi.advanceTimersByTimeAsync(1500); // parts 1 and 2 confirmed, part 3 in flight
    expect(item(id).bytesConfirmed).toBe(2 * MiB);
    before.engine.pauseAll('session'); // the tab goes away mid-upload

    // F5: a new engine on the same IndexedDB and the same server.
    const after = setup(server, repo, hasher);
    await after.engine.restore('u1');
    expect(item(id).state).toBe('needs_file');
    const sent = server.calls.length;

    await after.engine.reattach(id, testFile('B')); // same name, size and lastModified; different bytes
    await vi.advanceTimersByTimeAsync(5000);

    expect(hasher.sampled.at(-1)).toEqual([1, 2, 3]); // first, middle and last part were re-read
    expect(item(id)).toMatchObject({
      state: 'failed',
      failReason: 'different_file',
      error: { message: 'Fișierul ales este diferit de cel început.' },
    });
    expect(server.calls.length).toBe(sent); // not one byte of the other file went out

    // The right file is accepted and only the missing part is sent.
    await after.engine.reattach(id, testFile('A'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(item(id).state).toBe('verified');
    expect(server.calls.slice(sent).map((c) => c.partNumber)).toEqual([3]);
  });

  it('store updates at most 4 per second', async () => {
    // Two parts in flight, each reporting progress every 10 ms (200 events per second) and never finishing.
    const chatty: PartTransport = {
      send(args) {
        return new Promise((_resolve, reject) => {
          let sent = 0;
          const tick = setInterval(() => args.onProgress((sent = Math.min(args.body.size, sent + 4096))), 10);
          args.signal.addEventListener('abort', () => {
            clearInterval(tick);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    };
    const { engine } = setup(fakeServer({ transport: chatty }));
    await engine.restore('u1');
    const id = engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    await vi.advanceTimersByTimeAsync(500);
    expect(item(id).inFlightParts).toEqual([1, 2]);

    let writes = 0;
    const stop = useUploadStore.subscribe(() => writes++);
    const before = item(id).bytesInFlight;
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    const after = item(id).bytesInFlight;
    engine.pause(id);

    expect(writes).toBeLessThanOrEqual(4);
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(after).toBeGreaterThan(before); // coalesced, not dropped
  });

  it('a 401 pauses the upload for the session, tells the auth layer, and re-login resumes it', async () => {
    const server = fakeServer();
    let expired = true;
    const transport: PartTransport = {
      send: (args) => (expired ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.')) : server.transport.send(args)),
    };
    const onUnauthenticated = vi.fn();
    const { engine } = setup({ ...server, transport }, memoryRepo(), fakeHasher(), { onUnauthenticated });
    await engine.restore('u1');
    const id = engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    await vi.advanceTimersByTimeAsync(1000);

    expect(item(id)).toMatchObject({ state: 'paused', pausedReason: 'session' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated.mock.calls[0]![0]).toMatchObject({ status: 401 });

    expired = false; // the same user logs in again; AuthGate calls restoreAndResume
    await engine.restoreAndResume('u1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(item(id).state).toBe('verified');
  });
});
