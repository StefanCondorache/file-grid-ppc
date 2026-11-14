import type { HashIn, HashOut, HashResult } from './hash-core';

/** The engine's view of hashing; implemented by the worker proxy below (and by fakes in tests). */
export interface HashClient {
  hash(file: Blob, chunkSize: number, onProgress: (hashedBytes: number) => void, signal?: AbortSignal): Promise<HashResult>;
  sample(file: Blob, chunkSize: number, parts: number[], signal?: AbortSignal): Promise<Record<number, string>>;
}

export interface WorkerLike {
  onmessage: ((e: MessageEvent<HashOut>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(m: HashIn): void;
  terminate(): void;
}

type Pending = { resolve: (m: HashOut) => void; reject: (e: Error) => void; onProgress?: (b: number) => void };

function errorFrom(m: Extract<HashOut, { t: 'error' }>): Error {
  return m.name === 'AbortError' ? new DOMException(m.message, 'AbortError') : new Error(m.message);
}

/**
 * Main-thread proxy for hash.worker.ts. One lazily created worker multiplexes jobs by id; the File is passed by
 * reference (structured clone), never read on the main thread.
 */
export function createWorkerHasher(makeWorker: () => WorkerLike = defaultWorker): HashClient {
  let worker: WorkerLike | null = null;
  let nextJob = 1;
  const pending = new Map<number, Pending>();

  function failAll(error: Error): void {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  }

  function ensure(): WorkerLike {
    if (worker) return worker;
    const w = makeWorker();
    w.onmessage = ({ data }) => {
      const p = pending.get(data.job);
      if (!p) return;
      if (data.t === 'progress') {
        p.onProgress?.(data.bytes);
        return;
      }
      pending.delete(data.job);
      if (data.t === 'error') p.reject(errorFrom(data));
      else p.resolve(data);
    };
    w.onerror = (e) => failAll(new Error(e.message || 'Hash worker failed'));
    worker = w;
    return w;
  }

  function start(msg: (job: number) => HashIn, signal: AbortSignal | undefined, onProgress?: (b: number) => void): Promise<HashOut> {
    if (signal?.aborted) return Promise.reject(new DOMException('Hashing aborted', 'AbortError'));
    const w = ensure();
    const job = nextJob++;
    const onAbort = () => w.postMessage({ t: 'abort', job });
    return new Promise<HashOut>((resolve, reject) => {
      const settle = () => signal?.removeEventListener('abort', onAbort);
      pending.set(job, {
        resolve: (m) => (settle(), resolve(m)),
        reject: (e) => (settle(), reject(e)),
        onProgress,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      w.postMessage(msg(job));
    });
  }

  return {
    async hash(file, chunkSize, onProgress, signal) {
      const out = await start((job) => ({ t: 'hash', job, file, chunkSize }), signal, onProgress);
      if (out.t !== 'done') throw new Error(`Unexpected hash worker reply ${out.t}`);
      return { sha256: out.sha256, partHashes: out.partHashes };
    },
    async sample(file, chunkSize, parts, signal) {
      const out = await start((job) => ({ t: 'sample', job, file, chunkSize, parts }), signal);
      if (out.t !== 'sampled') throw new Error(`Unexpected hash worker reply ${out.t}`);
      return out.hashes;
    },
  };
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
