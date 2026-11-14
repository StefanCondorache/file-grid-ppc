import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/api/types';
import { clearClientState } from './clear-client-state';
import { scheduleSession } from './session';

const MIN = 60_000;

describe('scheduleSession', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('warns two minutes before expiry, corrected for clock skew', () => {
    const now = Date.now();
    const server = now + MIN; // server clock is one minute ahead
    const me = { serverTime: new Date(server).toISOString(), idleExpiresAt: new Date(server + 10 * MIN).toISOString(), expiresAt: new Date(server + 60 * MIN).toISOString() } as Me;
    const onWarn = vi.fn();
    const onExpire = vi.fn();
    scheduleSession(me, now, { onWarn, onExpire });
    vi.advanceTimersByTime(8 * MIN - 1);
    expect(onWarn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWarn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2 * MIN);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('the returned cancel stops both timers', () => {
    const now = Date.now();
    const me = { serverTime: new Date(now).toISOString(), idleExpiresAt: new Date(now + 5 * MIN).toISOString(), expiresAt: new Date(now + 5 * MIN).toISOString() } as Me;
    const onWarn = vi.fn();
    const cancel = scheduleSession(me, now, { onWarn, onExpire: onWarn });
    cancel();
    vi.advanceTimersByTime(10 * MIN);
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('clearClientState (Review Focus 2)', () => {
  const deps = () => ({
    queryClient: new QueryClient(),
    closeStream: vi.fn(),
    uploads: { pauseAll: vi.fn(), resumeAll: vi.fn(), restoreAndResume: vi.fn() },
    broadcast: { postMessage: vi.fn() } as unknown as BroadcastChannel,
  });

  it('on logout pauses uploads but never deletes upload records', () => {
    const d = deps();
    d.queryClient.setQueryData(['files', 'list', {}], { data: [1] });
    const deleteDb = vi.spyOn(indexedDB, 'deleteDatabase');
    clearClientState(d, 'logout');
    expect(d.uploads.pauseAll).toHaveBeenCalledWith('logout');
    expect(d.queryClient.getQueryData(['files', 'list', {}])).toBeUndefined();
    expect(d.closeStream).toHaveBeenCalled();
    expect(deleteDb).not.toHaveBeenCalled();
  });

  it('expiry pauses uploads for the session and does not broadcast a logout', () => {
    const d = deps();
    clearClientState(d, 'session');
    expect(d.uploads.pauseAll).toHaveBeenCalledWith('session');
    expect(d.broadcast.postMessage).not.toHaveBeenCalled();
  });

  it('broadcasts logout to other tabs', () => {
    const d = deps();
    clearClientState(d, 'logout');
    expect(d.broadcast.postMessage).toHaveBeenCalledWith({ type: 'logout' });
  });
});
