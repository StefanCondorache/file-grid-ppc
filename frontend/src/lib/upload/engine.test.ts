import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { DroneMetadata } from './contract';
import { createUploadEngine, type EngineDeps } from './engine';
import { createRepo } from './repo';
import type { UploadItemView } from './store';
import { createFakeServer, fakeNet, inProcessHasher, makeFile, MiB } from './testing/fakes';
import { realClock, type UploadState } from './types';

let dbn = 0;
const owner = { id: 'u1', role: 'teren' as const };
const drone: DroneMetadata = { kind: 'drone', lineSection: 'LEA 110 kV', zone: 'muntenia', inspectionDate: '2026-11-14' };

function setup(opts: Parameters<typeof createFakeServer>[0] = {}, repo = createRepo(`engine-test-${++dbn}`)) {
  const server = createFakeServer(opts);
  const net = fakeNet();
  const published: UploadItemView[][] = [];
  const onSessionExpired = vi.fn();
  const deps: EngineDeps = {
    api: server.api, transport: server.transport, repo, hasher: inProcessHasher, net, clock: realClock, rng: () => 0,
    publish: (v) => published.push([...v]), onSessionExpired,
  };
  const engine = createUploadEngine(deps);
  const view = (id: string) => engine.views().find((v) => v.id === id);
  const states = (id: string) =>
    published.map((p) => p.find((v) => v.id === id)?.state).filter((s, i, a): s is UploadState => !!s && s !== a[i - 1]);
  const until = (id: string, state: UploadState, timeout = 8000) => vi.waitFor(() => expect(view(id)?.state).toBe(state), { timeout, interval: 5 });
  return { server, net, published, onSessionExpired, engine, view, states, until, repo, deps };
}

const sha = async (f: File) => createHash('sha256').update(new Uint8Array(await f.arrayBuffer())).digest('hex');

describe('upload engine', () => {
  it('runs enqueue → hashing → uploading → verifying → verified', async () => {
    const t = setup();
    const file = makeFile(2.5 * MiB);
    const id = t.engine.enqueue({ file, category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'verified');
    expect(t.states(id)).toEqual(['queued', 'hashing', 'uploading', 'verifying', 'verified']);
    const v = t.view(id)!;
    expect(v.clientSha256).toBe(await sha(file));
    expect(v.result).toMatchObject({ verdict: 'match', fileId: expect.any(String), serverSha256: v.clientSha256 });
    expect([v.bytesConfirmed, v.partCount, v.policyVersion]).toEqual([2.5 * MiB, 3, 7]);
    expect([...t.server.sent].sort()).toEqual([1, 2, 3]);
    await vi.waitFor(async () => expect(await t.repo.get(id)).toBeUndefined());
  });

  it('marks a hash mismatch failed with no file id', async () => {
    const t = setup();
    t.server.knobs.mismatch = true;
    const id = t.engine.enqueue({ file: makeFile(MiB + 10), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'failed');
    const v = t.view(id)!;
    expect([v.failReason, v.result?.fileId, v.result?.verdict, v.resumable]).toEqual(['checksum_mismatch', null, 'mismatch', false]);
    expect(v.message).toBe('Amprenta nu coincide. Fișierul nu a fost păstrat.');
  });

  it('rejects a reattached file whose sampled part hashes differ (Review Focus 1)', async () => {
    const repo = createRepo(`engine-test-${++dbn}`);
    const a = setup({ partDelayMs: 400 }, repo);
    const original = makeFile(3 * MiB, 'drona.mp4', 3);
    const id = a.engine.enqueue({ file: original, category: 'drone_videos', metadata: drone, owner });
    await a.until(id, 'uploading');
    a.engine.pause(id);
    await vi.waitFor(async () => expect((await repo.get(id))?.partSha256).toHaveLength(3));
    // A reload: a new engine over the same IndexedDB, with no handle for the file.
    const b = setup({}, repo);
    for (const [k, s] of a.server.sessions) b.server.sessions.set(k, s);
    await b.engine.restore('u1');
    await b.until(id, 'needs_file');
    const impostor = makeFile(3 * MiB, 'drona.mp4', 9); // same name, size and date, other bytes
    expect(await b.engine.reattach(id, impostor)).toBe('different_file');
    expect(b.view(id)).toMatchObject({ state: 'failed', failReason: 'different_file', message: 'Fișierul ales este diferit de cel început.' });
    expect(await b.engine.reattach(id, original)).toBe('ok');
    await b.until(id, 'verified');
    expect(b.view(id)!.clientSha256).toBe(await sha(original));
  });

  it('pauses on a 401 and resumes for the same user after re-login', async () => {
    const t = setup();
    t.server.knobs.partErrors.push(new ApiError(401, 'UNAUTHENTICATED', 'x'));
    const id = t.engine.enqueue({ file: makeFile(2 * MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'paused');
    expect(t.view(id)!.pauseReason).toBe('session');
    expect(t.onSessionExpired).toHaveBeenCalledTimes(1);
    t.engine.pauseAll('session');
    t.engine.resumeAll('u2');
    expect(t.view(id)?.state ?? 'paused').toBe('paused');
    t.engine.resumeAll('u1');
    await t.until(id, 'verified');
  });

  it('pauses and resumes on demand, without sending while paused', async () => {
    const t = setup({ partDelayMs: 30 });
    const id = t.engine.enqueue({ file: makeFile(4 * MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'uploading');
    t.engine.pause(id);
    expect(t.view(id)).toMatchObject({ state: 'paused', pauseReason: 'user' });
    const sent = t.server.sent.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(t.server.sent.length).toBe(sent);
    t.engine.resume(id);
    await t.until(id, 'verified');
  });

  it('cancels: deletes the server session and the local record', async () => {
    const t = setup({ partDelayMs: 50 });
    const id = t.engine.enqueue({ file: makeFile(4 * MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'uploading');
    await t.engine.cancel(id);
    expect(t.view(id)).toBeUndefined();
    expect(t.server.cancelled).toEqual(['up-1']);
    expect(await t.repo.get(id)).toBeUndefined();
  });

  it('resends the parts the server reports missing at complete', async () => {
    const t = setup();
    t.server.knobs.dropBeforeComplete.push(2);
    const id = t.engine.enqueue({ file: makeFile(3 * MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'verified');
    expect(t.server.sent.filter((n) => n === 2)).toHaveLength(2);
  });

  it('polls GET /uploads/{id} after a 202 until the result is there', async () => {
    const t = setup();
    t.server.knobs.slowPolls = 2;
    const id = t.engine.enqueue({ file: makeFile(MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'verified');
    expect(t.view(id)!.result?.verdict).toBe('match');
  });

  it('publishes progress at most 4 times per second (transitions at once)', async () => {
    const t = setup({ partDelayMs: 25, maxParallel: 1 });
    const id = t.engine.enqueue({ file: makeFile(40 * MiB), category: 'drone_videos', metadata: drone, owner });
    const started = Date.now();
    await t.until(id, 'verified', 15_000);
    const seconds = (Date.now() - started) / 1000;
    const transitions = t.states(id).length;
    expect(t.published.length).toBeLessThanOrEqual(transitions + Math.ceil(seconds * 4) + 2);
    expect(t.published.length).toBeLessThan(40);
  });

  it('runs at most 2 uploads of one category at once; the rest wait in the queue', async () => {
    const t = setup({ partDelayMs: 20 });
    const ids = [1, 2, 3].map((i) => t.engine.enqueue({ file: makeFile(2 * MiB, `d${i}.mp4`, i), category: 'drone_videos', metadata: drone, owner }));
    for (const id of ids) await t.until(id, 'verified');
    const active: UploadState[] = ['hashing', 'uploading', 'connection_lost', 'verifying'];
    const peak = Math.max(...t.published.map((p) => p.filter((v) => active.includes(v.state)).length));
    expect(peak).toBe(2);
  });

  it('never persists personal data and shows the server-safe name', async () => {
    const t = setup({ partDelayMs: 200 });
    const id = t.engine.enqueue({
      file: makeFile(MiB, 'CI_Popescu_Ion.pdf', 1, 'application/pdf'),
      category: 'connection_documents',
      metadata: { kind: 'connection', requestNumber: 'R-1', documentType: 'cerere', applicantName: 'Ion Popescu', cnp: '1960101410019' },
      owner,
    });
    await t.until(id, 'uploading');
    const json = JSON.stringify(await t.repo.get(id));
    for (const pii of ['1960101410019', 'Popescu', 'cnp', 'applicantName']) expect(json).not.toContain(pii);
    expect(t.view(id)!.displayName).toBe('Document racordare R-1 (cerere)');
    expect(t.server.sessions.get('up-1')!.req.metadata).toMatchObject({ cnp: '1960101410019' });
  });

  it('fails resumably after 10 attempts on a part, and Reia continues', async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) t.server.knobs.partErrors.push(new ApiError(503, 'STORAGE_UNAVAILABLE', 'x', 't', [], 0, { storage: 'ftp' }));
    const id = t.engine.enqueue({ file: makeFile(MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'failed', 15_000);
    expect(t.view(id)).toMatchObject({ failReason: 'retries_exhausted', resumable: true, retries: 9 }); // 10 attempts = 1 send + 9 retries
    t.engine.retry(id);
    await t.until(id, 'verified');
  });

  it('names the storage while it is down and keeps retrying', async () => {
    const t = setup({ partDelayMs: 5 });
    t.server.knobs.partErrors.push(new ApiError(503, 'STORAGE_UNAVAILABLE', 'x', 't', [], 50, { storage: 's3' }));
    const id = t.engine.enqueue({ file: makeFile(MiB), category: 'drone_videos', metadata: drone, owner });
    await vi.waitFor(() => expect(t.view(id)?.message).toBe('S3 nu este disponibil. Celelalte categorii funcționează normal. Reîncercăm automat.'), { timeout: 5000, interval: 2 });
    await t.until(id, 'verified');
  });

  it('waits offline as connection lost and continues by itself when back online', async () => {
    const t = setup({ partDelayMs: 40 });
    const id = t.engine.enqueue({ file: makeFile(4 * MiB), category: 'drone_videos', metadata: drone, owner });
    await t.until(id, 'uploading');
    t.net.set(false);
    expect(t.view(id)).toMatchObject({ state: 'connection_lost', offline: true });
    await new Promise((r) => setTimeout(r, 60));
    t.net.set(true);
    await t.until(id, 'verified');
  });
});
