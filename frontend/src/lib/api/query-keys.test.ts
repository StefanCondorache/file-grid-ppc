import { describe, expect, it } from 'vitest';
import { useAppStore } from '@/stores/app-store';
import { qk } from './query-keys';

describe('query keys', () => {
  it('keys are stable and hierarchical', () => {
    expect(qk.files.list({ category: 'fault' })[0]).toBe('files');
    expect(qk.files.list({ category: 'fault' })).toEqual(qk.files.list({ category: 'fault' }));
    expect(qk.files.detail('f1').slice(0, 1)).toEqual(qk.files.all);
  });
});

describe('app store', () => {
  it('tracks live status and the live-updates pause', () => {
    useAppStore.getState().setLive({ reconnectingInS: 4 });
    useAppStore.getState().setLivePaused(true);
    expect(useAppStore.getState().live).toEqual({ reconnectingInS: 4 });
    expect(useAppStore.getState().livePaused).toBe(true);
    useAppStore.getState().markEvent(1234);
    expect(useAppStore.getState().lastEventAt).toBe(1234);
  });
});
