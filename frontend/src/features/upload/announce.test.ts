import { describe, expect, it } from 'vitest';
import type { UploadItemView } from '@/lib/upload/store';
import { uploadAnnouncements } from './announce';

const base: UploadItemView = {
  id: 'a', displayName: 'f.pdf', category: 'fault_records', size: 100, bytesConfirmed: 0, bytesInFlight: 0, hashedBytes: 0,
  speedBps: null, etaS: null, state: 'uploading', offline: false, startedAsRole: null, ownerUserId: 'u', partCount: 10,
  confirmed: new Uint8Array(2), inFlightParts: [], retryingParts: [], reopenable: false,
};
const at = (n: number, extra: Partial<UploadItemView> = {}) => ({ ...base, bytesConfirmed: n, ...extra });

describe('uploadAnnouncements', () => {
  it('stays quiet between marks', () => expect(uploadAnnouncements(at(26), at(27))).toBeNull());
  it('announces 50 %', () => expect(uploadAnnouncements(at(49), at(50))?.text).toContain('50%'));
  it('announces failures assertively', () =>
    expect(uploadAnnouncements(at(10), at(10, { state: 'failed', failReason: 'unknown' }))?.priority).toBe('assertive'));
  it('announces connection_lost once', () => {
    const lost = at(10, { state: 'connection_lost' });
    expect(uploadAnnouncements(at(10), lost)).not.toBeNull();
    expect(uploadAnnouncements(lost, { ...lost, retryAt: 5 })).toBeNull();
  });
});
