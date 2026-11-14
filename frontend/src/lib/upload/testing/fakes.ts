/** Test-only fakes for the engine's ports (never imported by app code). */
import { ApiError } from '@/lib/api/errors';
import type { CompleteOutcome, PartSend, PartTransport, UploadApi } from '../api';
import { partsToRanges, type CompleteResult, type CreateUploadRequest, type UploadSession } from '../contract';
import { hashBlob, sampleParts } from '../hash-core';
import type { HashClient } from '../hasher';
import type { NetMonitor } from '../net';
import type { PolicySnapshot } from '../types';

export const MiB = 1024 * 1024;

export function fakeNet(online = true): NetMonitor & { set(o: boolean): void } {
  const listeners = new Set<(o: boolean) => void>();
  const net = {
    online,
    subscribe(l: (o: boolean) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reportNetworkError() {},
    reportSuccess() {},
    dispose() {},
    set(o: boolean) {
      net.online = o;
      listeners.forEach((l) => l(o));
    },
  };
  return net;
}

/** The real hash code, run in-process instead of in a worker. */
export const inProcessHasher: HashClient = {
  hash: (file, chunkSize, onProgress, signal) => hashBlob(file, chunkSize, onProgress, signal),
  sample: (file, chunkSize, parts, signal) => sampleParts(file, chunkSize, parts, signal),
};

type FakeSession = { id: string; key: string; req: CreateUploadRequest; parts: Set<number>; status: UploadSession['status']; result: CompleteResult | null; polls: number; partCount: number };

/** An in-memory backend speaking the upload contract, with knobs for the error paths. */
export function createFakeServer(opts: { chunkSize?: number; maxParallel?: number; partDelayMs?: number } = {}) {
  const chunkSize = opts.chunkSize ?? MiB;
  const sessions = new Map<string, FakeSession>();
  const cancelled: string[] = [];
  const sent: number[] = [];
  const knobs = {
    mismatch: false,
    slowPolls: 0,
    /** Parts to forget once before complete (PARTS_MISSING). */
    dropBeforeComplete: [] as number[],
    /** Fail the next part sends with these errors, in order. */
    partErrors: [] as ApiError[],
    onSend: null as null | ((args: PartSend) => void),
  };

  const policy: PolicySnapshot = {
    category: 'drone_videos', version: 7, primaryStorage: 'ftp', fallbackStorage: 's3', encryptionAtRest: false,
    chunkSize, maxParallel: opts.maxParallel ?? 2, maxFileSize: 4096 * MiB, allowedTypes: [],
  };

  function result(s: FakeSession, sha: string): CompleteResult {
    const serverSha256 = knobs.mismatch ? `${sha.slice(0, 63)}${sha.endsWith('0') ? '1' : '0'}` : sha;
    return {
      status: knobs.mismatch ? 'failed' : 'completed', verdict: knobs.mismatch ? 'mismatch' : 'match', fileId: knobs.mismatch ? null : `file-${s.id}`,
      clientSha256: sha, serverSha256, size: s.req.fileSize, storage: 'ftp', usedFallback: false, policyVersion: 7, encryptedAtRest: false,
      availableAt: new Date().toISOString(), availableAfterMs: 1200, traceId: 'trace-1',
    };
  }

  const api: UploadApi = {
    async policy(category) {
      return { ...policy, category };
    },
    async create(req, key) {
      const existing = [...sessions.values()].find((s) => s.key === key);
      const s: FakeSession = existing ?? { id: `up-${sessions.size + 1}`, key, req, parts: new Set(), status: 'open', result: null, polls: 0, partCount: Math.ceil(req.fileSize / chunkSize) };
      sessions.set(s.id, s);
      return {
        uploadId: s.id, status: s.status, chunkSize, partCount: s.partCount, maxParallel: policy.maxParallel, policyVersion: 7, maxFileSize: policy.maxFileSize,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), displayName: req.category === 'connection_documents' ? 'Document racordare R-1 (cerere)' : req.fileName,
        receivedRanges: partsToRanges([...s.parts]),
      };
    },
    async status(id) {
      const s = sessions.get(id);
      if (!s) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'x');
      if (s.status === 'verifying' && ++s.polls > knobs.slowPolls) s.status = s.result?.verdict === 'mismatch' ? 'failed' : 'completed';
      return {
        uploadId: s.id, status: s.status, fileSize: s.req.fileSize, chunkSize, partCount: s.partCount, receivedRanges: partsToRanges([...s.parts]),
        receivedBytes: 0, policyVersion: 7, expiresAt: '', startedAsRole: 'teren', result: s.status === 'completed' || s.status === 'failed' ? s.result : null, error: null,
      };
    },
    async complete(id, sha, partCount): Promise<CompleteOutcome> {
      const s = sessions.get(id)!;
      if (partCount !== s.partCount) throw new ApiError(422, 'PART_COUNT_MISMATCH', 'x');
      for (const n of knobs.dropBeforeComplete.splice(0)) s.parts.delete(n);
      const missing = Array.from({ length: s.partCount }, (_, i) => i + 1).filter((n) => !s.parts.has(n));
      if (missing.length) throw new ApiError(409, 'PARTS_MISSING', 'x', 't', [], null, { code: 'PARTS_MISSING', missingRanges: partsToRanges(missing) });
      s.result = result(s, sha);
      if (knobs.slowPolls > 0) {
        s.status = 'verifying';
        return { kind: 'verifying', retryAfterMs: 10 };
      }
      s.status = s.result.verdict === 'match' ? 'completed' : 'failed';
      return { kind: 'done', result: s.result };
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };

  const transport: PartTransport = {
    send(args) {
      knobs.onSend?.(args);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const e = knobs.partErrors.shift();
          if (e) return reject(e);
          sent.push(args.partNumber);
          sessions.get(args.uploadId)!.parts.add(args.partNumber);
          args.onProgress(args.body.size);
          resolve({ partNumber: args.partNumber, size: args.body.size, sha256: args.sha256Hex, alreadyReceived: false });
        }, opts.partDelayMs ?? 2);
        args.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };

  return { api, transport, sessions, cancelled, sent, knobs, policy };
}

/** A File with deterministic content. */
export function makeFile(size: number, name = 'drona_0412.mp4', fill = 3, type = 'video/mp4', lastModified = 1_700_000_000_000): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096 + fill) % 251;
  return new File([bytes], name, { type, lastModified });
}
