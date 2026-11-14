import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStream } from './stream';

class FakeES {
  static instances: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  fail() { this.readyState = 2; this.onerror?.(); }
}

describe('final review #6: polling fallback when the stream never opens', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeES.instances = []; });
  afterEach(() => vi.useRealTimers());

  it('gives up after 3 failed connects that never opened', async () => {
    const onGiveUp = vi.fn();
    connectStream({
      url: '/s', EventSourceImpl: FakeES as unknown as typeof EventSource, rng: () => 0.5,
      onEvent: () => {}, onOpen: () => {}, onStatus: () => {}, onExpired: () => {},
      checkSession: async () => 'ok', onGiveUp,
    });
    for (let i = 0; i < 3; i++) {
      FakeES.instances[FakeES.instances.length - 1]!.fail();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(FakeES.instances).toHaveLength(3);
  });
});
