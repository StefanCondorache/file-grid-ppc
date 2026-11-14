import { apiUrl } from '@/lib/api/base';
import { backoffMs } from './backoff';
import type { Clock } from './types';

export interface NetMonitor {
  readonly online: boolean;
  subscribe(listener: (online: boolean) => void): () => void;
  /** Heuristic input from the transport: a request failed at the network level. */
  reportNetworkError(): void;
  reportSuccess(): void;
  dispose(): void;
}

export type NetWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & { navigator: { onLine: boolean } };

const SUSPECT_WINDOW_MS = 5000;
const PROBE_BASE_MS = 1000;
const PROBE_CAP_MS = 15_000;

/**
 * Connectivity (upload-engine.md §7, UE-10): `navigator.onLine === false` is trusted at once; `true` is not, so an
 * `online` event (or a suspected outage) starts HEAD /ping probes on a backoff schedule and only a successful probe
 * (or request) brings the monitor back online.
 */
export function createNetMonitor(deps: { win: NetWindow; probe(): Promise<boolean>; rng: () => number; clock: Clock }): NetMonitor {
  const { win, probe, rng, clock } = deps;
  const listeners = new Set<(online: boolean) => void>();
  let online = win.navigator.onLine;
  let errors: number[] = [];
  let probeTimer: unknown = null;
  let probing = false;
  let attempt = 0;

  function set(next: boolean): void {
    if (next === online) return;
    online = next;
    listeners.forEach((l) => l(next));
  }

  function stopProbing(): void {
    if (probeTimer !== null) clock.clearTimeout(probeTimer);
    probeTimer = null;
    probing = false;
    attempt = 0;
  }

  async function probeOnce(): Promise<void> {
    probeTimer = null;
    const ok = await probe();
    if (!probing) return;
    if (ok && win.navigator.onLine) {
      stopProbing();
      errors = [];
      set(true);
      return;
    }
    if (!win.navigator.onLine) {
      stopProbing();
      return;
    }
    probeTimer = clock.setTimeout(() => void probeOnce(), backoffMs(attempt++, rng, PROBE_BASE_MS, PROBE_CAP_MS));
  }

  function startProbing(): void {
    if (probing) return;
    probing = true;
    attempt = 0;
    probeTimer = clock.setTimeout(() => void probeOnce(), 0);
  }

  const onOffline = () => {
    stopProbing();
    set(false);
  };
  const onOnline = () => startProbing();
  win.addEventListener('offline', onOffline);
  win.addEventListener('online', onOnline);

  return {
    get online() {
      return online;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportNetworkError() {
      const now = clock.now();
      errors = [...errors.filter((t) => now - t < SUSPECT_WINDOW_MS), now];
      if (errors.length >= 2 && online) {
        set(false);
        if (win.navigator.onLine) startProbing();
      }
    },
    reportSuccess() {
      errors = [];
      stopProbing();
      set(true);
    },
    dispose() {
      stopProbing();
      win.removeEventListener('offline', onOffline);
      win.removeEventListener('online', onOnline);
      listeners.clear();
    },
  };
}

/** HEAD /ping (204, no auth, no-store) with a 3 s timeout; any failure means "not reachable". */
export function createPingProbe(fetchFn: typeof fetch = (...a) => fetch(...a), timeoutMs = 3000): () => Promise<boolean> {
  return async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(apiUrl('/ping'), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: ac.signal });
      return res.ok;
    } catch {
      return false; // a network error or the timeout: the server is not reachable yet
    } finally {
      clearTimeout(timer);
    }
  };
}
