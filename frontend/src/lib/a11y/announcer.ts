export type Priority = 'polite' | 'assertive';
type Region = { text: string; count: number };
type State = Record<Priority, Region>;

const DEDUPE_MS = 2000;
let state: State = { polite: { text: '', count: 0 }, assertive: { text: '', count: 0 } };
const lastSeen = new Map<string, number>();
const listeners = new Set<() => void>();

/** Speak a message through the shared live regions (A11Y-11); identical messages within 2 s are dropped. */
export function announce(message: string, priority: Priority = 'polite'): void {
  const key = `${priority}:${message}`;
  const now = Date.now();
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return;
  lastSeen.set(key, now);
  state = { ...state, [priority]: { text: message, count: state[priority].count + 1 } };
  listeners.forEach((l) => l());
}

export function getAnnouncements(): State {
  return state;
}

export function subscribeAnnouncements(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetAnnouncer(): void {
  state = { polite: { text: '', count: 0 }, assertive: { text: '', count: 0 } };
  lastSeen.clear();
}
