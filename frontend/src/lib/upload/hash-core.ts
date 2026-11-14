import { createSHA256 } from 'hash-wasm';

/**
 * Hash-first pass (upload-engine.md §9, ADR-0004): one sequential read of the file in `Blob.slice` parts.
 * hash-wasm hashes the whole file incrementally; WebCrypto digests each part (one-shot, native).
 * At most one part buffer is alive at a time, so memory does not grow with the file size.
 */
export interface HashResult {
  sha256: string;
  partHashes: string[];
}

function abortError(): Error {
  return new DOMException('Hashing aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function digestHex(buf: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', buf));
}

export async function hashBlob(blob: Blob, chunkSize: number, onProgress: (hashedBytes: number) => void, signal?: AbortSignal): Promise<HashResult> {
  const whole = await createSHA256();
  whole.init();
  const partHashes: string[] = [];
  for (let start = 0; start < blob.size; start += chunkSize) {
    throwIfAborted(signal);
    const end = Math.min(blob.size, start + chunkSize);
    const buf = await blob.slice(start, end).arrayBuffer();
    throwIfAborted(signal);
    whole.update(new Uint8Array(buf));
    partHashes.push(await digestHex(buf));
    onProgress(end);
  }
  throwIfAborted(signal);
  return { sha256: whole.digest('hex'), partHashes };
}

/** Re-hash only some parts (1-based), to check a re-attached file is the one started (upload-engine.md §8.4). */
export async function sampleParts(blob: Blob, chunkSize: number, parts: number[], signal?: AbortSignal): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const n of parts) {
    throwIfAborted(signal);
    const start = (n - 1) * chunkSize;
    out[n] = await digestHex(await blob.slice(start, Math.min(blob.size, start + chunkSize)).arrayBuffer());
  }
  return out;
}

export type HashIn =
  | { t: 'hash'; job: number; file: Blob; chunkSize: number }
  | { t: 'sample'; job: number; file: Blob; chunkSize: number; parts: number[] }
  | { t: 'abort'; job: number };

export type HashOut =
  | { t: 'progress'; job: number; bytes: number }
  | { t: 'done'; job: number; sha256: string; partHashes: string[] }
  | { t: 'sampled'; job: number; hashes: Record<number, string> }
  | { t: 'error'; job: number; name: string; message: string };

/** The worker's message handler, kept here so it runs (and is tested) without a Worker. */
export function createHashService(post: (m: HashOut) => void, opts: { progressIntervalMs?: number } = {}) {
  const interval = opts.progressIntervalMs ?? 100;
  const jobs = new Map<number, AbortController>();

  async function run(job: number, work: (signal: AbortSignal) => Promise<HashOut>): Promise<void> {
    const ac = new AbortController();
    jobs.set(job, ac);
    try {
      post(await work(ac.signal));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      post({ t: 'error', job, name: e.name, message: e.message });
    } finally {
      jobs.delete(job);
    }
  }

  return async (m: HashIn): Promise<void> => {
    if (m.t === 'abort') {
      jobs.get(m.job)?.abort();
      return;
    }
    if (m.t === 'sample') {
      await run(m.job, async (signal) => ({ t: 'sampled', job: m.job, hashes: await sampleParts(m.file, m.chunkSize, m.parts, signal) }));
      return;
    }
    let last = -Infinity;
    await run(m.job, async (signal) => {
      const result = await hashBlob(
        m.file,
        m.chunkSize,
        (bytes) => {
          const now = Date.now();
          if (now - last < interval && interval > 0) return;
          last = now;
          post({ t: 'progress', job: m.job, bytes });
        },
        signal,
      );
      return { t: 'done', job: m.job, ...result };
    });
  };
}
