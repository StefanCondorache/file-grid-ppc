import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { drone, fakeHasher, fakeServer, item, memoryRepo, MiB, setup, SIZE, testFile } from '@/test/upload-fakes';
import type { PartTransport } from './api';
import { useUploadStore } from './store';

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

  it('only upload activity keeps a record alive: a paused, restored upload is purged after 24 h', async () => {
    const HOUR = 60 * 60 * 1000;
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const first = setup(server, repo);
    await first.engine.restore('u1');
    const id = first.engine.enqueue({ file: testFile('A'), category: 'drone_videos', metadata: drone });
    await vi.advanceTimersByTimeAsync(1500); // parts 1 and 2 confirmed
    const lastActivity = repo.records.get(id)!.updatedAt;
    first.engine.pauseAll('logout');

    await vi.advanceTimersByTimeAsync(12 * HOUR);
    await setup(server, repo).engine.restore('u1'); // shown again as needs_file: not activity
    expect(item(id).state).toBe('needs_file');
    expect(repo.records.get(id)!.updatedAt).toBe(lastActivity);

    await vi.advanceTimersByTimeAsync(13 * HOUR); // the server dropped the session after 24 h without parts
    await setup(server, repo).engine.restore('u1');
    expect(repo.records.has(id)).toBe(false);
    expect(useUploadStore.getState().items[id]).toBeUndefined();
  });
});
