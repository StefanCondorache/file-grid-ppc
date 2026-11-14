import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNetMonitor, createPingProbe, type NetWindow } from './net';
import { realClock } from './types';

function fakeWindow(onLine = true): NetWindow & { go(online: boolean): void } {
  const target = new EventTarget();
  const nav = { onLine };
  return {
    navigator: nav,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    go(online: boolean) {
      nav.onLine = online;
      target.dispatchEvent(new Event(online ? 'online' : 'offline'));
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('network monitor', () => {
  it('goes offline at once on the offline event', () => {
    const win = fakeWindow();
    const net = createNetMonitor({ win, probe: async () => true, rng: () => 0.5, clock: realClock });
    const seen: boolean[] = [];
    net.subscribe((o) => seen.push(o));
    expect(net.online).toBe(true);
    win.go(false);
    expect(net.online).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('does not trust the online event until the probe succeeds', async () => {
    const win = fakeWindow(false);
    const answers = [false, false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const net = createNetMonitor({ win, probe, rng: () => 0.5, clock: realClock });
    expect(net.online).toBe(false);
    win.go(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.online).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); // backoff(0) with rng 0.5 → 500 ms
    expect(net.online).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); // backoff(1) → 1000 ms
    expect(probe).toHaveBeenCalledTimes(3);
    expect(net.online).toBe(true);
  });

  it('suspects offline after two network errors within 5 s, and probes back', async () => {
    const win = fakeWindow(true);
    const probe = vi.fn(async () => true);
    const net = createNetMonitor({ win, probe, rng: () => 0.5, clock: realClock });
    net.reportNetworkError();
    await vi.advanceTimersByTimeAsync(6000);
    net.reportNetworkError();
    expect(net.online).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    net.reportNetworkError();
    expect(net.online).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalled();
    expect(net.online).toBe(true);
  });

  it('a success clears the suspicion', () => {
    const win = fakeWindow(true);
    const net = createNetMonitor({ win, probe: () => new Promise(() => {}), rng: () => 0.5, clock: realClock });
    net.reportNetworkError();
    net.reportNetworkError();
    expect(net.online).toBe(false);
    net.reportSuccess();
    expect(net.online).toBe(true);
  });

  it('stops listening on dispose', () => {
    const win = fakeWindow(true);
    const net = createNetMonitor({ win, probe: async () => true, rng: () => 0.5, clock: realClock });
    net.dispose();
    win.go(false);
    expect(net.online).toBe(true);
  });
});

describe('ping probe', () => {
  it('sends HEAD /ping without cache and is true on 204', async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: init?.method === 'HEAD' ? 204 : 500 }));
    const probe = createPingProbe(fetchFn as unknown as typeof fetch);
    expect(await probe()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/ping', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }));
  });

  it('is false on a network error or a timeout', async () => {
    vi.useRealTimers();
    expect(await createPingProbe(async () => { throw new TypeError('Failed to fetch'); })()).toBe(false);
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('t', 'AbortError'))));
    expect(await createPingProbe(hanging as unknown as typeof fetch, 20)()).toBe(false);
  });
});
