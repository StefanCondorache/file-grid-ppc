// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScenario } from './scenario';

describe('scenario clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits ping with monotonic ids', () => {
    const s = createScenario();
    const seen: number[] = [];
    s.on((e) => { if (e.type === 'ping') seen.push(e.id); });
    s.start();
    vi.advanceTimersByTime(60_000);
    s.stop();
    expect(seen).toHaveLength(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(3);
  });

  it('delivers emitted events to every listener', () => {
    const s = createScenario();
    const a = vi.fn();
    const b = vi.fn();
    s.on(a);
    const off = s.on(b);
    s.emit('policy.updated', { category: 'fault', version: 4 });
    off();
    s.emit('policy.updated', { category: 'fault', version: 5 });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).toMatchObject({ type: 'policy.updated', data: { version: 4 } });
  });
});
