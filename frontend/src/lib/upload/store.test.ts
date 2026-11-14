import { describe, expect, it } from 'vitest';
import { publishToStore, useUploadStore, type UploadItemView } from './store';

const view = (id: string, over: Partial<UploadItemView> = {}): UploadItemView => ({
  id, ownerUserId: 'u1', startedAsRole: 'teren', category: 'drone_videos', displayName: `${id}.mp4`, size: 10, state: 'uploading',
  pauseReason: null, failReason: null, message: null, errorCode: null, traceId: null, hashedBytes: 10, bytesConfirmed: 0, bytesInFlight: 0,
  speedBps: null, etaS: null, retryAt: null, offline: false, retries: 0, partCount: 2, parts: new Uint8Array([0, 1]), policyVersion: 1,
  primaryStorage: 'ftp', fallbackStorage: 's3', encryptionAtRest: false, chunkSize: 5, maxParallel: 2, clientSha256: null, result: null,
  needsPermission: false, resumable: false, ...over,
});

describe('upload store', () => {
  it('keeps the identity of unchanged rows so only the changed row re-renders', () => {
    publishToStore([view('a'), view('b')]);
    const first = useUploadStore.getState().items;
    publishToStore([view('a'), view('b', { bytesConfirmed: 5, parts: new Uint8Array([2, 1]) })]);
    const next = useUploadStore.getState();
    expect(next.items.a).toBe(first.a);
    expect(next.items.b).not.toBe(first.b);
    expect(next.order).toEqual(['a', 'b']);
  });

  it('drops rows that are no longer published', () => {
    publishToStore([view('a')]);
    publishToStore([]);
    expect(useUploadStore.getState()).toEqual({ items: {}, order: [] });
  });
});
