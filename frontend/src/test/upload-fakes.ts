/**
 * Fake ports for upload engine tests (lib/upload): an in-memory backend that survives a "reload", an in-memory
 * IndexedDB, a hasher that "reads" a seed instead of bytes, and a stand-in for a Chromium file handle.
 */
import { vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { CompleteOutcome, PartSend, PartTransport, UploadApi } from '@/lib/upload/api';
import { partsToRanges, type CompleteResult, type DroneMetadata, type UploadSession, type UploadStatus } from '@/lib/upload/contract';
import { createUploadEngine, type EngineDeps } from '@/lib/upload/engine';
import type { HashClient } from '@/lib/upload/hasher';
import type { NetMonitor } from '@/lib/upload/net';
import type { UploadRepo } from '@/lib/upload/repo';
import { useUploadStore, type UploadItemView } from '@/lib/upload/store';
import { realClock, type PersistedUpload, type PolicySnapshot, type UploadCategoryId } from '@/lib/upload/types';

export const MiB = 1024 * 1024;
/** Three parts of 1 MiB, the last one half. */
export const SIZE = 2.5 * MiB;
export const drone: DroneMetadata = { kind: 'drone', lineSection: 'LEA 110 kV Reșița–Timișoara', zone: 'banat', inspectionDate: '2026-11-14' };

/** What the fake hasher "reads": files made from the same seed have the same bytes. */
const seeds = new WeakMap<Blob, string>();
export function testFile(seed: string, name = 'inspectie-linia-7.mp4', lastModified = 1_763_100_000_000, size = SIZE): File {
  const file = new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified });
  seeds.set(file, seed);
  return file;
}
const seedOf = (b: Blob) => seeds.get(b) ?? 'unknown';
const partHash = (seed: string, n: number) => `${seed}:part-${n}`;

export function fakeHasher(): HashClient & { sampled: number[][] } {
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

export const POLICY: PolicySnapshot = {
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

type ServerUpload = { key: string; size: number; partCount: number; received: Set<number>; result: CompleteResult | null };

/** An in-memory backend: sessions survive a "reload" (a second engine on the same server and repo). */
export function fakeServer(opts: { verdict?: 'match' | 'mismatch'; latencyMs?: number; transport?: PartTransport } = {}) {
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
  const partSize = (u: ServerUpload, n: number) => Math.min(MiB, u.size - (n - 1) * MiB);
  const api = {
    policy: vi.fn(async (category: UploadCategoryId) => ({ ...POLICY, category })),
    create: vi.fn(async (req, key): Promise<UploadSession> => {
      let id = [...uploads].find(([, u]) => u.key === key)?.[0];
      if (!id) {
        id = `srv-${uploads.size + 1}`;
        uploads.set(id, { key, size: req.fileSize, partCount: Math.ceil(req.fileSize / MiB), received: new Set(), result: null });
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
    status: vi.fn(async (uploadId: string): Promise<UploadStatus> => {
      const u = uploads.get(uploadId);
      if (!u) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Încărcarea nu există.');
      return {
        uploadId,
        status: u.result?.status ?? 'open',
        fileSize: u.size,
        chunkSize: MiB,
        partCount: u.partCount,
        receivedRanges: partsToRanges([...u.received]),
        receivedBytes: [...u.received].reduce((sum, n) => sum + partSize(u, n), 0),
        policyVersion: 3,
        expiresAt: '2026-11-15T12:00:00Z',
        startedAsRole: 'teren',
        result: u.result,
        error: null,
      };
    }),
    complete: vi.fn(async (uploadId: string, sha256: string): Promise<CompleteOutcome> => {
      const u = uploads.get(uploadId)!;
      u.result ??= result(uploadId, sha256);
      return { kind: 'done', result: u.result };
    }),
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

/** IndexedDB in memory. Handles are kept as they are: fake-indexeddb cannot clone file-system handles. */
export function memoryRepo(): UploadRepo & { records: Map<string, PersistedUpload>; handles: Map<string, unknown> } {
  const records = new Map<string, PersistedUpload>();
  const handles = new Map<string, unknown>();
  return {
    records,
    handles,
    put: async (r) => void records.set(r.localId, structuredClone(r)),
    get: async (id) => structuredClone(records.get(id)),
    listFor: async (userId) => [...records.values()].filter((r) => r.userId === userId).map((r) => structuredClone(r)),
    markPart: async () => {},
    remove: async (id) => {
      records.delete(id);
      handles.delete(id);
    },
    purgeOlderThan: async (ms) => {
      const stale = [...records.values()].filter((r) => r.updatedAt < Date.now() - ms);
      stale.forEach((r) => records.delete(r.localId));
      return stale.length;
    },
    putHandle: async (id, h) => void handles.set(id, h),
    getHandle: async (id) => handles.get(id),
  };
}

export const onlineNet = (): NetMonitor => ({ online: true, subscribe: () => () => {}, reportNetworkError() {}, reportSuccess() {}, dispose() {} });

export function setup(server = fakeServer(), repo = memoryRepo(), hasher = fakeHasher(), over: Partial<EngineDeps> = {}) {
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

export const item = (id: string): UploadItemView => useUploadStore.getState().items[id]!;
