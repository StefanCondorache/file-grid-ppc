// @vitest-environment node
// jsdom lacks a complete crypto.subtle / Blob.arrayBuffer; hashing is pure Node-compatible code.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHashService, hashBlob, sampleParts, type HashOut } from './hash-core';

const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('incremental SHA-256 over Blob.slice', () => {
  it('hashes "abc" to the FIPS 180-2 vector', async () => {
    const { sha256, partHashes } = await hashBlob(new Blob(['abc']), 5 * MiB, () => {});
    expect(sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(partHashes).toEqual([sha256]);
  });

  it('gives per-part and whole-file digests equal to Node crypto for a 3-part file', async () => {
    const bytes = new Uint8Array(randomBytes(12 * MiB));
    const progress: number[] = [];
    const { sha256, partHashes } = await hashBlob(new Blob([bytes]), 5 * MiB, (b) => progress.push(b));
    expect(partHashes).toEqual([sha(bytes.subarray(0, 5 * MiB)), sha(bytes.subarray(5 * MiB, 10 * MiB)), sha(bytes.subarray(10 * MiB))]);
    expect(sha256).toBe(sha(bytes));
    expect(progress).toEqual([5 * MiB, 10 * MiB, 12 * MiB]);
  });

  it('rejects with an AbortError when aborted', async () => {
    const ac = new AbortController();
    const run = hashBlob(new Blob([new Uint8Array(12 * MiB)]), 5 * MiB, () => ac.abort(), ac.signal);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('re-hashes only the sampled parts', async () => {
    const bytes = new Uint8Array(randomBytes(11 * MiB));
    const hashes = await sampleParts(new Blob([bytes]), 5 * MiB, [1, 3]);
    expect(hashes).toEqual({ 1: sha(bytes.subarray(0, 5 * MiB)), 3: sha(bytes.subarray(10 * MiB)) });
  });
});

describe('worker message protocol', () => {
  it('answers a hash job with progress then done, and a sample job with its hashes', async () => {
    const out: HashOut[] = [];
    const service = createHashService((m) => out.push(m), { progressIntervalMs: 0 });
    const blob = new Blob([new Uint8Array(randomBytes(6 * MiB))]);
    await service({ t: 'hash', job: 1, file: blob, chunkSize: 5 * MiB });
    await service({ t: 'sample', job: 2, file: blob, chunkSize: 5 * MiB, parts: [2] });
    expect(out.filter((m) => m.t === 'progress').map((m) => m.t === 'progress' && m.bytes)).toEqual([5 * MiB, 6 * MiB]);
    const done = out.find((m) => m.t === 'done');
    expect(done).toMatchObject({ job: 1 });
    expect(done && done.t === 'done' && done.partHashes).toHaveLength(2);
    expect(out.find((m) => m.t === 'sampled')).toMatchObject({ job: 2, hashes: { 2: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it('reports an abort as an error message for that job only', async () => {
    const out: HashOut[] = [];
    const service = createHashService((m) => out.push(m), { progressIntervalMs: 0 });
    const blob = new Blob([new Uint8Array(12 * MiB)]);
    const running = service({ t: 'hash', job: 7, file: blob, chunkSize: 5 * MiB });
    await service({ t: 'abort', job: 7 });
    await running;
    expect(out.at(-1)).toEqual({ t: 'error', job: 7, name: 'AbortError', message: expect.any(String) });
  });

  it('throttles progress messages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const out: HashOut[] = [];
    const service = createHashService((m) => out.push(m), { progressIntervalMs: 100 });
    await service({ t: 'hash', job: 3, file: new Blob([new Uint8Array(3 * MiB)]), chunkSize: 1 * MiB });
    vi.useRealTimers();
    // Three parts at the same instant: only the first progress (and the final done) are sent.
    expect(out.filter((m) => m.t === 'progress')).toHaveLength(1);
    expect(out.at(-1)?.t).toBe('done');
  });
});
