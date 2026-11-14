import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStream } from './stream';

class FakeES {
  static instances: FakeES[] = [];
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: MessageEvent) => void>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (m: MessageEvent) => void) { this.listeners.set(type, fn); }
  close() { this.readyState = FakeES.CLOSED; }
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.readyState = FakeES.CLOSED; this.onerror?.(); }
  push(type: string, id: number, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId: String(id) } as MessageEvent); }
}

const last = () => FakeES.instances[FakeES.instances.length - 1]!;

function start(checkSession = async () => 'ok' as const) {
  const calls = { open: 0, statuses: [] as unknown[], expired: 0, events: [] as unknown[] };
  const handle = connectStream({
    url: '/api/v1/stream',
    EventSourceImpl: FakeES as unknown as typeof EventSource,
    rng: () => 0.5,
    onEvent: (e) => calls.events.push(e),
    onOpen: () => { calls.open++; },
    onStatus: (s) => calls.statuses.push(s),
    onExpired: () => { calls.expired++; },
    checkSession,
  });
  return { handle, calls };
}

describe('connectStream', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeES.instances = []; });
  afterEach(() => vi.useRealTimers());

  it('parses named events and remembers the last event id', () => {
    const { calls } = start();
    last().open();
    last().push('meters.counters', 7, { received: 10 });
    expect(calls.events).toEqual([{ type: 'meters.counters', id: 7, data: { received: 10 } }]);
  });

  it('reconnects when no event arrives for 45 s, even without an error event (Review Focus 4)', async () => {
    start();
    last().open();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(FakeES.instances[0]!.readyState).toBe(FakeES.CLOSED);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeES.instances).toHaveLength(2);
  });

  it('calls onOpen after every reconnect so the cache can resync, resuming from Last-Event-ID', async () => {
    const { calls } = start();
    last().open();
    last().push('ping', 41, {});
    last().fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(last().url).toContain('lastEventId=41');
    last().open();
    expect(calls.open).toBe(2);
  });

  it('stops retrying and reports expired when the session check fails', async () => {
    const { calls } = start(async () => 'expired');
    last().fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.expired).toBe(1);
    expect(FakeES.instances).toHaveLength(1);
  });

  it('backs off 1, 2, 4… up to 30 s', async () => {
    const { calls } = start();
    for (let i = 0; i < 7; i++) {
      last().fail();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    const waits = calls.statuses.filter((s): s is { reconnectingInS: number } => typeof s === 'object').map((s) => s.reconnectingInS);
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });
});
