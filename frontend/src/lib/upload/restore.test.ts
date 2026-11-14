import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { drone, fakeServer, item, memoryRepo, MiB, setup, testFile } from '@/test/upload-fakes';
import type { UploadEngine } from './engine';
import { useUploadStore } from './store';

/** Four parts of 1 MiB, the last one half: two in flight at a time. */
const SIZE4 = 3.5 * MiB;
const fileA = () => testFile('A', 'inspectie-linia-7.mp4', 1_763_100_000_000, SIZE4);

/** A Chromium FileSystemFileHandle for `file`; `access` is what queryPermission answers. */
function fakeHandle(file: File, access: PermissionState = 'granted') {
  return {
    kind: 'file' as const,
    name: file.name,
    queryPermission: vi.fn(async () => access),
    requestPermission: vi.fn(async () => (access = 'granted')),
    getFile: vi.fn(async () => file),
  };
}

type Repo = ReturnType<typeof memoryRepo>;

/** F5: the page dies mid-upload; its parts in flight are cut off and IndexedDB keeps what it held at that moment. */
function reload(engine: UploadEngine, repo: Repo): void {
  const disk = new Map([...repo.records].map(([id, r]) => [id, structuredClone(r)]));
  engine.pauseAll('logout'); // only to stop the dead page's timers
  repo.records.clear();
  for (const [id, r] of disk) repo.records.set(id, r);
}

const sentSince = (server: ReturnType<typeof fakeServer>, from: number) => server.calls.slice(from).map((c) => c.partNumber).sort();

/** Transient user activation: the call runs inside a click (jsdom has no navigator.userActivation). */
function inClick(): void {
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true, hasBeenActive: true } });
}

beforeEach(() => {
  vi.useFakeTimers();
  useUploadStore.setState({ items: {} });
});
afterEach(() => {
  vi.useRealTimers();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

describe('resume after reload', () => {
  it('a granted handle resumes with no click and sends only the parts the server is missing', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const file = fileA();
    const handle = fakeHandle(file);
    const before = setup(server, repo);
    await before.engine.restore('u1');
    const id = before.engine.enqueue({ file, category: 'drone_videos', metadata: drone, handle });
    await vi.advanceTimersByTimeAsync(1500); // parts 1 and 2 confirmed, 3 and 4 in flight
    expect(item(id).bytesConfirmed).toBe(2 * MiB);
    reload(before.engine, repo);
    expect(repo.records.get(id)!.state).toBe('uploading');
    // Part 3 reached the server just as the tab closed: its receipt never arrived, so the local bitset lacks it.
    server.uploads.get('srv-1')!.received.add(3);
    const sent = server.calls.length;

    const after = setup(server, repo);
    await after.engine.restore('u1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(handle.getFile).toHaveBeenCalledTimes(1);
    expect(handle.requestPermission).not.toHaveBeenCalled(); // "Allow on every visit": no prompt, no click
    expect(server.api.status).toHaveBeenCalledWith('srv-1');
    expect(sentSince(server, sent)).toEqual([4]); // server {1,2,3} ∪ local {1,2}: only part 4 is missing
    expect(item(id)).toMatchObject({ state: 'verified', fileId: 'file-of-srv-1', bytesConfirmed: SIZE4 });
  });

  it('without a usable handle it waits for the file: needs_file', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const before = setup(server, repo);
    await before.engine.restore('u1');
    // <input type=file> gives no handle; a dropped file's read access can lapse; a dropped file can be moved away.
    const picked = before.engine.enqueue({ file: fileA(), category: 'drone_videos', metadata: drone });
    const lapsedFile = testFile('B', 'inspectie-linia-8.mp4');
    const lapsed = fakeHandle(lapsedFile, 'prompt');
    const prompted = before.engine.enqueue({ file: lapsedFile, category: 'drone_videos', metadata: drone, handle: lapsed });
    const movedFile = testFile('C', 'inspectie-linia-9.mp4');
    const moved = { ...fakeHandle(movedFile), getFile: vi.fn(() => Promise.reject(new DOMException('gone', 'NotFoundError'))) };
    const gone = before.engine.enqueue({ file: movedFile, category: 'drone_videos', metadata: drone, handle: moved });
    await vi.advanceTimersByTimeAsync(1500);
    reload(before.engine, repo);
    const sent = server.calls.length;

    const after = setup(server, repo);
    await after.engine.restore('u1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(item(picked)).toMatchObject({ state: 'needs_file', reopenable: false });
    // One click on the row (grantFileAccess) can bring this one back; Chrome is never prompted outside a click.
    expect(item(prompted)).toMatchObject({ state: 'needs_file', reopenable: true });
    expect(lapsed.requestPermission).not.toHaveBeenCalled();
    expect(item(gone)).toMatchObject({ state: 'needs_file', reopenable: false });
    expect(server.calls.length).toBe(sent);
    expect(server.api.status).not.toHaveBeenCalled();
  });

  it('one click gives a reopenable upload its file back; a refusal leaves only the re-select', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const fileB = testFile('B', 'inspectie-linia-8.mp4');
    const lapsed = fakeHandle(fileA(), 'prompt'); // Chrome did not keep "Allow on every visit"
    const refused = { ...fakeHandle(fileB, 'prompt'), requestPermission: vi.fn(async (): Promise<PermissionState> => 'denied') };
    const before = setup(server, repo);
    await before.engine.restore('u1');
    const id = before.engine.enqueue({ file: await lapsed.getFile(), category: 'drone_videos', metadata: drone, handle: lapsed });
    const other = before.engine.enqueue({ file: fileB, category: 'drone_videos', metadata: drone, handle: refused });
    await vi.advanceTimersByTimeAsync(1500);
    reload(before.engine, repo);
    const after = setup(server, repo);
    await after.engine.restore('u1');
    expect(item(id)).toMatchObject({ state: 'needs_file', reopenable: true });
    const sent = server.calls.length;

    inClick(); // "Continuă încărcarea" on the row
    await after.engine.grantFileAccess(id);
    await after.engine.grantFileAccess(other);
    await vi.advanceTimersByTimeAsync(5000);

    expect(lapsed.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(item(id).state).toBe('verified');
    expect(sentSince(server, sent)).toEqual([3, 4]);
    expect(item(other)).toMatchObject({ state: 'needs_file', reopenable: false });
  });

  it('a pause the user chose survives the reload: the file is not reopened on its own', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const file = fileA();
    const handle = fakeHandle(file);
    const before = setup(server, repo);
    await before.engine.restore('u1');
    const id = before.engine.enqueue({ file, category: 'drone_videos', metadata: drone, handle });
    await vi.advanceTimersByTimeAsync(1500);
    before.engine.pause(id);
    reload(before.engine, repo);
    const sent = server.calls.length;

    await setup(server, repo).engine.restore('u1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(item(id)).toMatchObject({ state: 'needs_file', reopenable: true });
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(server.calls.length).toBe(sent);
  });

  // Review Focus 2: the session ends mid-upload, then a different user signs in on the same browser.
  it('does not resume another user’s upload', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const file = fileA();
    const handle = fakeHandle(file);
    let signedIn = 'u1';
    const asSignedIn = { whoami: async () => ({ userId: signedIn, role: 'teren' as const }) };
    // Like the backend: an upload is only visible to the real user who started it.
    const ownStatus = server.api.status.getMockImplementation()!;
    server.api.status.mockImplementation(async (uploadId) => {
      if (signedIn !== 'u1') throw new ApiError(403, 'FORBIDDEN', 'Nu ai acces la această încărcare.');
      return ownStatus(uploadId);
    });
    const hidden = () => expect(useUploadStore.getState().items).toEqual({});
    const waitsForU1 = () => expect(repo.records.get(id)).toMatchObject({ userId: 'u1', state: 'paused', pauseReason: 'session' });

    const tab = setup(server, repo, undefined, asSignedIn);
    await tab.engine.restoreAndResume('u1');
    const id = tab.engine.enqueue({ file, category: 'drone_videos', metadata: drone, handle });
    await vi.advanceTimersByTimeAsync(1500); // parts 1 and 2 confirmed, 3 and 4 in flight
    const sent = server.calls.length;

    // Same tab: u2 signs in, AuthGate restores for u2. u1's upload stops and disappears.
    signedIn = 'u2';
    await tab.engine.restoreAndResume('u2');
    await vi.advanceTimersByTimeAsync(5000);
    hidden();
    waitsForU1();
    expect(server.calls.length).toBe(sent);

    // F5 while u2 is signed in: u1's record stays paused and hidden, and its file is not even reopened.
    reload(tab.engine, repo);
    const u2Tab = setup(server, repo, undefined, asSignedIn);
    await u2Tab.engine.restoreAndResume('u2');
    await vi.advanceTimersByTimeAsync(5000);
    hidden();
    waitsForU1();
    expect(handle.getFile).not.toHaveBeenCalled();

    // F5 as u1, but u2 signs in while u1's file is still being reopened: the late file changes nothing.
    reload(u2Tab.engine, repo);
    let release = () => {};
    handle.getFile.mockImplementationOnce(() => new Promise<File>((resolve) => (release = () => resolve(file))));
    const raced = setup(server, repo, undefined, asSignedIn);
    const restoring = raced.engine.restoreAndResume('u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.getFile).toHaveBeenCalledTimes(1);
    signedIn = 'u2';
    await raced.engine.restoreAndResume('u2');
    release();
    await restoring;
    await vi.advanceTimersByTimeAsync(5000);
    hidden();
    waitsForU1();
    expect(server.calls.length).toBe(sent);
    expect(server.api.status).not.toHaveBeenCalled(); // nothing is asked about u1's upload under u2's session

    // F5 and u1 signs in again: the upload continues where it stopped, with no click.
    reload(raced.engine, repo);
    signedIn = 'u1';
    await setup(server, repo, undefined, asSignedIn).engine.restoreAndResume('u1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(item(id).state).toBe('verified');
    expect(sentSince(server, sent)).toEqual([3, 4]);
  });

  it('a connection document always waits for the file to be picked again: needs_file', async () => {
    const server = fakeServer({ latencyMs: 1000 });
    const repo = memoryRepo();
    const file = testFile('D', 'CI_Popescu_Ion.pdf');
    const handle = fakeHandle(file);
    const before = setup(server, repo);
    await before.engine.restore('u1');
    const id = before.engine.enqueue({
      file,
      category: 'connection_documents',
      metadata: { kind: 'connection', requestNumber: 'RC-2026-000123', documentType: 'act_identitate', applicantName: 'Ion Popescu', cnp: '1960101410019' },
      handle,
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(repo.handles.has(id)).toBe(false); // never stored next to an identity document (UE-12)
    reload(before.engine, repo);
    // Even a handle that did reach IndexedDB (an older version, a bug) is never used for personal data.
    await repo.putHandle(id, handle);
    const sent = server.calls.length;

    const after = setup(server, repo);
    await after.engine.restore('u1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(item(id)).toMatchObject({ state: 'needs_file', reopenable: false });
    expect(handle.queryPermission).not.toHaveBeenCalled();
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(server.calls.length).toBe(sent);
  });
});
