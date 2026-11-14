// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHashService, type HashIn, type HashOut } from './hash-core';
import { createWorkerHasher, type WorkerLike } from './hasher';

const MiB = 1024 * 1024;

/** Runs the real worker handler in-process: the proxy only sees postMessage / onmessage. */
function fakeWorker(): WorkerLike & { terminated: boolean } {
  const w = {
    onmessage: null as ((e: MessageEvent<HashOut>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    terminated: false,
    postMessage(m: HashIn) {
      void service(m);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const service = createHashService((m) => w.onmessage?.({ data: m } as MessageEvent<HashOut>), { progressIntervalMs: 0 });
  return w;
}

describe('worker hasher proxy', () => {
  it('resolves hash and sample jobs and forwards progress', async () => {
    const bytes = new Uint8Array(randomBytes(7 * MiB));
    const hasher = createWorkerHasher(fakeWorker);
    const progress: number[] = [];
    const result = await hasher.hash(new Blob([bytes]), 5 * MiB, (b) => progress.push(b));
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(progress).toEqual([5 * MiB, 7 * MiB]);
    const sampled = await hasher.sample(new Blob([bytes]), 5 * MiB, [2]);
    expect(sampled[2]).toBe(result.partHashes[1]);
  });

  it('rejects with AbortError when the signal aborts', async () => {
    const hasher = createWorkerHasher(fakeWorker);
    const ac = new AbortController();
    const run = hasher.hash(new Blob([new Uint8Array(20 * MiB)]), 1 * MiB, () => ac.abort(), ac.signal);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails pending jobs when the worker crashes', async () => {
    let worker: ReturnType<typeof fakeWorker> | null = null;
    const hasher = createWorkerHasher(() => {
      worker = fakeWorker();
      worker.postMessage = () => {};
      return worker;
    });
    const run = hasher.hash(new Blob(['x']), 5 * MiB, () => {});
    worker!.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(run).rejects.toThrow('boom');
  });
});
