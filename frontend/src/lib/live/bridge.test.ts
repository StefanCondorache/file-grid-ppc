import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk, STREAM_FED_KEYS } from '@/lib/api/query-keys';
import { createBridge } from './bridge';
import type { StreamEvent, StreamEventType } from './events';

const ev = (type: StreamEventType, data: unknown, id = 1): StreamEvent => ({ type, id, data });

function setup() {
  const qc = new QueryClient();
  const deps = { announce: vi.fn() };
  return { qc, deps, bridge: createBridge(qc, deps) };
}

describe('stream-to-cache bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes snapshots straight into the cache', () => {
    const { qc, bridge } = setup();
    bridge.apply(ev('meters.counters', { received: 5, lost: 0 }));
    bridge.apply(ev('guarantees.status', { items: [{ category: 'fault', state: 'at_risk' }] }));
    bridge.apply(ev('storage.health', { items: [{ storage: 'S3', status: 'down' }] }));
    bridge.apply(ev('simulator.status', { mode: 'peak', ratePerS: 320 }));
    expect(qc.getQueryData(qk.meters.counters)).toEqual({ received: 5, lost: 0 });
    expect(qc.getQueryData(qk.guarantees)).toEqual({ data: [{ category: 'fault', state: 'at_risk' }] });
    expect(qc.getQueryData(qk.health)).toEqual({ data: [{ storage: 'S3', status: 'down' }] });
    expect(qc.getQueryData(qk.meters.simulator)).toEqual({ mode: 'peak', ratePerS: 320 });
  });

  it('upserts alerts by id, newest first', () => {
    const { qc, bridge } = setup();
    qc.setQueryData(qk.alerts, { data: [{ id: 'a1', state: 'at_risk' }], meta: { total: 1 } });
    bridge.apply(ev('alert.updated', { id: 'a1', state: 'resolved' }));
    bridge.apply(ev('alert.raised', { id: 'a2', state: 'violated' }));
    expect((qc.getQueryData(qk.alerts) as { data: { id: string; state: string }[] }).data).toEqual([
      { id: 'a2', state: 'violated' },
      { id: 'a1', state: 'resolved' },
    ]);
  });

  it('invalidates on change events', () => {
    const { qc, bridge } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    bridge.apply(ev('policy.updated', { category: 'fault', version: 4 }));
    bridge.apply(ev('file.integrity', { fileId: 'f9', state: 'corrupt' }));
    bridge.apply(ev('demo.storm', { category: 'fault', state: 'started' }));
    bridge.apply(ev('upload.verified', { uploadId: 'u7', verdict: 'match' }));
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toEqual(expect.arrayContaining([qk.policies.all, qk.files.detail('f9'), qk.demo.status]));
  });

  it('coalesces fault announcements during a storm', () => {
    const { deps, bridge } = setup();
    for (let i = 0; i < 10; i++) bridge.apply(ev('file.created', { fileId: `f${i}`, category: 'fault_records', zone: 'dobrogea', substation: 'PT 4' }, i));
    vi.advanceTimersByTime(5_000);
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledWith('10 avarii noi');
  });

  it('announces a single new fault with its place', () => {
    const { deps, bridge } = setup();
    // The backend's upload-assembler.ts payload carries the real category id.
    bridge.apply(ev('file.created', { fileId: 'f1', category: 'fault_records', zone: 'dobrogea', substation: 'PT Medgidia 4' }));
    vi.advanceTimersByTime(5_000);
    expect(deps.announce).toHaveBeenCalledWith('Avarie nouă: Dobrogea, PT Medgidia 4');
  });

  it('also announces faults under the short id, and never other categories', () => {
    const { deps, bridge } = setup();
    bridge.apply(ev('file.created', { fileId: 'm1', category: 'meter_readings', zone: 'banat' }, 1));
    bridge.apply(ev('file.created', { fileId: 'd1', category: 'drone_videos', zone: 'banat' }, 2));
    vi.advanceTimersByTime(5_000);
    expect(deps.announce).not.toHaveBeenCalled();
    bridge.apply(ev('file.created', { fileId: 'f1', category: 'fault', zone: 'banat', substation: 'PT Reșița 21' }, 3));
    vi.advanceTimersByTime(5_000);
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledWith('Avarie nouă: Banat, PT Reșița 21');
  });

  it('resyncs every stream-fed key on open', () => {
    const { qc, bridge } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    bridge.resync();
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([...STREAM_FED_KEYS]);
  });

  it('buffers while paused and applies the latest snapshot on resume', () => {
    const { qc, bridge } = setup();
    bridge.setPaused(true);
    bridge.apply(ev('meters.counters', { received: 1 }));
    bridge.apply(ev('meters.counters', { received: 2 }));
    expect(qc.getQueryData(qk.meters.counters)).toBeUndefined();
    bridge.setPaused(false);
    expect(qc.getQueryData(qk.meters.counters)).toEqual({ received: 2 });
  });

  it('falls back to polling when the stream is unavailable', () => {
    const { qc, bridge } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const stop = bridge.startPolling();
    vi.advanceTimersByTime(3_000);
    expect(spy).toHaveBeenCalledTimes(STREAM_FED_KEYS.length);
    stop();
  });
});
