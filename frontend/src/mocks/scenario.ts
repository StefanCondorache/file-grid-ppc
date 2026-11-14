import type { StreamEvent, StreamEventType } from '@/lib/live/events';

type Listener = (e: StreamEvent) => void;

const PING_MS = 20_000;

/** Mock "server" event clock (6a.8). Slice 6e extends its state (storms, storage, counters) in place. */
export function createScenario() {
  const listeners = new Set<Listener>();
  let nextId = 1;
  let timer: ReturnType<typeof setInterval> | null = null;

  const api = {
    emit(type: StreamEventType, data: unknown): StreamEvent {
      const e: StreamEvent = { type, id: nextId++, data };
      listeners.forEach((l) => l(e));
      return e;
    },
    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => api.emit('ping', { serverTime: new Date().toISOString() }), PING_MS);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return api;
}

export type Scenario = ReturnType<typeof createScenario>;

/** The single scenario of the running mock. */
export const scenario = createScenario();
