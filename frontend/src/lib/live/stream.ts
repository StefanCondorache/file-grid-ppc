import type { AppLiveStatus } from '@/stores/app-store';
import { STREAM_EVENT_TYPES, type StreamEvent } from './events';

const WATCHDOG_MS = 45_000;
const BACKOFF_S = [1, 2, 4, 8, 16, 30];

type Options = {
  url: string;
  onEvent: (e: StreamEvent) => void;
  /** Called on every (re)open: resync stream-fed queries over REST (FA-8). */
  onOpen: () => void;
  onStatus: (s: AppLiveStatus) => void;
  onExpired: () => void;
  checkSession: () => Promise<'ok' | 'expired'>;
  EventSourceImpl?: typeof EventSource;
  /** Called once after `maxFailures` consecutive connects that never opened (e.g. no /stream on the backend). */
  onGiveUp?: () => void;
  maxFailures?: number;
  rng?: () => number;
};

/**
 * One SSE connection with a 45 s watchdog (Cloudflare can cut idle streams silently), our own jittered backoff
 * after the browser gives up (readyState CLOSED), Last-Event-ID resume, and a session check before each retry.
 */
export function connectStream(opts: Options): { close(): void; reconnect(): void } {
  const ES = opts.EventSourceImpl ?? EventSource;
  const rng = opts.rng ?? Math.random;
  let es: EventSource | null = null;
  let lastId: number | null = null;
  let attempt = 0;
  let failuresWithoutOpen = 0;
  let closed = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (watchdog) clearTimeout(watchdog);
    if (retry) clearTimeout(retry);
    watchdog = retry = null;
  };

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      es?.close();
      void scheduleRetry();
    }, WATCHDOG_MS);
  };

  const open = () => {
    if (closed) return;
    const url = lastId === null ? opts.url : `${opts.url}${opts.url.includes('?') ? '&' : '?'}lastEventId=${lastId}`;
    const current = new ES(url, { withCredentials: true });
    es = current;
    opts.onStatus('connecting');
    current.onopen = () => {
      attempt = 0;
      failuresWithoutOpen = 0;
      opts.onStatus('open');
      opts.onOpen();
      armWatchdog();
    };
    current.onerror = () => {
      if (current.readyState === 2) void scheduleRetry();
      else opts.onStatus({ reconnectingInS: 3 });
    };
    for (const type of STREAM_EVENT_TYPES) {
      current.addEventListener(type, (m: MessageEvent) => {
        const id = Number(m.lastEventId);
        if (Number.isFinite(id) && m.lastEventId !== '') lastId = id;
        armWatchdog();
        opts.onEvent({ type, id: lastId ?? 0, data: JSON.parse(m.data as string) });
      });
    }
  };

  const scheduleRetry = async () => {
    if (closed || retry) return;
    if (watchdog) clearTimeout(watchdog);
    failuresWithoutOpen += 1;
    if (opts.onGiveUp && failuresWithoutOpen >= (opts.maxFailures ?? 3)) {
      closed = true;
      clearTimers();
      es?.close();
      opts.onGiveUp();
      return;
    }
    if ((await opts.checkSession()) === 'expired') {
      closed = true;
      clearTimers();
      opts.onExpired();
      return;
    }
    const base = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]! * 1000;
    const delay = base * (1 + (rng() * 2 - 1) * 0.3);
    attempt += 1;
    opts.onStatus({ reconnectingInS: Math.ceil(delay / 1000) });
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
  };

  const onOnline = () => api.reconnect();
  const onOffline = () => opts.onStatus('offline');
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  const api = {
    close() {
      closed = true;
      clearTimers();
      es?.close();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    },
    reconnect() {
      if (closed) return;
      clearTimers();
      es?.close();
      attempt = 0;
      open();
    },
  };

  open();
  return api;
}
