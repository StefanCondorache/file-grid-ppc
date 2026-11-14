import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { PartSend, PartTransport } from './api';
import { seededRng } from './backoff';
import type { NetMonitor } from './net';
import { classifyError, createScheduler, type ActiveUpload, type SchedulerSignal } from './scheduler';
import { realClock } from './types';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeNet(online = true): NetMonitor & { set(o: boolean): void; errors: number } {
  const listeners = new Set<(o: boolean) => void>();
  const net = {
    online,
    errors: 0,
    subscribe(l: (o: boolean) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reportNetworkError() {
      net.errors++;
    },
    reportSuccess() {},
    dispose() {},
    set(o: boolean) {
      net.online = o;
      listeners.forEach((l) => l(o));
    },
  };
  return net;
}

type Outcome = 'ok' | ApiError;
/** A transport that answers each send after `latencyMs` with the next scripted outcome (default ok). */
function scriptedTransport(script: (args: PartSend, call: number) => Outcome, latencyMs = 10) {
  let active = 0;
  let maxActive = 0;
  const calls: PartSend[] = [];
  const transport: PartTransport = {
    send(args) {
      calls.push(args);
      const call = calls.length;
      active++;
      maxActive = Math.max(maxActive, active);
      args.onProgress(1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          active--;
          const out = script(args, call);
          if (out === 'ok') resolve({ partNumber: args.partNumber, size: args.body.size, sha256: args.sha256Hex, alreadyReceived: false });
          else reject(out);
        }, latencyMs);
        args.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          active--;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };
  return { transport, calls, maxActive: () => maxActive };
}

const net0 = () => new ApiError(0, 'NETWORK', 'down');
const err = (status: number, code: string, retryAfterMs: number | null = null) => new ApiError(status, code, code, 't', [], retryAfterMs);

function upload(partCount: number, over: Partial<ActiveUpload> = {}): ActiveUpload {
  const chunkSize = 4;
  return {
    uploadId: 'u1',
    file: new Blob([new Uint8Array(partCount * chunkSize - 1)]),
    chunkSize,
    partCount,
    partHashes: Array.from({ length: partCount }, (_, i) => String(i + 1).padStart(64, '0')),
    isConfirmed: () => false,
    maxParallel: 3,
    ...over,
  };
}

function run(transport: PartTransport, net = fakeNet(), rng = () => 0.5) {
  const signals: SchedulerSignal[] = [];
  const s = createScheduler({ transport, net, clock: realClock, rng, onSignal: (x) => signals.push(x) });
  const ok = () => signals.filter((x) => x.type === 'part_ok').map((x) => (x.type === 'part_ok' ? x.n : 0));
  const last = () => signals.at(-1);
  return { s, signals, ok, last, net };
}

describe('error classification (upload-engine.md §6)', () => {
  it.each([
    [net0(), 'retry'],
    [err(429, 'RATE_LIMITED'), 'retry'],
    [err(503, 'STORAGE_UNAVAILABLE'), 'retry'],
    [err(503, 'CATEGORY_BUSY'), 'retry'],
    [err(502, 'HTTP_ERROR'), 'retry'],
    [err(522, 'HTTP_ERROR'), 'retry'],
    [err(401, 'UNAUTHENTICATED'), 'session'],
    [err(409, 'UPLOAD_NOT_OPEN'), 'reconcile'],
    [err(409, 'UPLOAD_COMPLETED'), 'reconcile'],
    [err(422, 'PART_CHECKSUM_MISMATCH'), 'checksum'],
    [err(422, 'PART_SIZE_MISMATCH'), 'checksum'],
  ] as const)('%o → %s', (e, kind) => {
    expect(classifyError(e).kind).toBe(kind);
  });

  it.each([
    [err(403, 'FORBIDDEN'), 'forbidden'],
    [err(403, 'CSRF_REJECTED'), 'forbidden'],
    [err(404, 'UPLOAD_NOT_FOUND'), 'upload_gone'],
    [err(413, 'PART_TOO_LARGE'), 'too_large'],
    [err(422, 'PART_NUMBER_OUT_OF_RANGE'), 'policy_violation'],
    [err(415, 'UNSUPPORTED_MEDIA_TYPE'), 'policy_violation'],
    [err(400, 'BAD_REQUEST'), 'policy_violation'],
  ] as const)('%o is fatal (%s)', (e, reason) => {
    expect(classifyError(e)).toEqual({ kind: 'fatal', reason });
  });

  it('our own abort is not an error', () => {
    expect(classifyError(new DOMException('x', 'AbortError')).kind).toBe('abort');
  });
});

describe('part scheduler', () => {
  it('never exceeds the parallelism ceiling, clamped to 6', async () => {
    const a = scriptedTransport(() => 'ok');
    run(a.transport).s.start(upload(20, { maxParallel: 3 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.maxActive()).toBe(3);
    const b = scriptedTransport(() => 'ok');
    run(b.transport).s.start(upload(20, { maxParallel: 10 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.maxActive()).toBe(6);
  });

  it('sends the lowest unconfirmed parts first and skips confirmed ones', async () => {
    const t = scriptedTransport(() => 'ok');
    const r = run(t.transport);
    r.s.start(upload(6, { maxParallel: 1, isConfirmed: (n) => n === 1 || n === 3 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls.map((c) => c.partNumber)).toEqual([2, 4, 5, 6]);
    expect(t.calls[0]!.body.size).toBe(4);
    expect(t.calls.at(-1)!.body.size).toBe(3); // last part is shorter
    expect(t.calls[0]!.sha256Hex).toBe('2'.padStart(64, '0'));
    expect(r.last()).toEqual({ type: 'all_done' });
  });

  it('confirms each part exactly once under random failures (20 seeds)', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const failRng = seededRng(seed * 7919);
      const t = scriptedTransport(() => {
        const x = failRng();
        return x < 0.25 ? net0() : x < 0.35 ? err(503, 'STORAGE_UNAVAILABLE', 500) : 'ok';
      });
      const r = run(t.transport, fakeNet(), seededRng(seed));
      r.s.start(upload(25, { maxParallel: 4 }));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const ok = r.ok();
      expect([seed, ok.length, new Set(ok).size]).toEqual([seed, 25, 25]);
      expect(r.signals.filter((x) => x.type === 'all_done')).toHaveLength(1);
      expect(r.signals.some((x) => x.type === 'fatal')).toBe(false);
    }
  });

  it('a 401 aborts in-flight parts without counting attempts and signals the session', async () => {
    let first = true;
    const t = scriptedTransport((args) => (args.partNumber === 1 && first ? ((first = false), err(401, 'UNAUTHENTICATED')) : 'ok'), 10);
    const r = run(t.transport);
    r.s.start(upload(4, { maxParallel: 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(r.signals.find((x) => x.type === 'session')).toBeDefined();
    expect(t.calls[1]!.signal.aborted).toBe(true);
    const sent = t.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls.length).toBe(sent); // paused: nothing else is sent
    r.s.start(upload(4, { maxParallel: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.ok().sort()).toEqual([1, 2, 3, 4]);
  });

  it('409 UPLOAD_NOT_OPEN stops and asks the engine to reconcile', async () => {
    const t = scriptedTransport(() => err(409, 'UPLOAD_NOT_OPEN'));
    const r = run(t.transport);
    r.s.start(upload(3, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.signals.filter((x) => x.type === 'reconcile')).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it('retries a checksum mismatch, then fails with file_changed after the third', async () => {
    const t = scriptedTransport(() => err(422, 'PART_CHECKSUM_MISMATCH'));
    const r = run(t.transport);
    r.s.start(upload(1, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(3);
    expect(r.last()).toMatchObject({ type: 'fatal', reason: 'file_changed' });
  });

  it('fails with retries_exhausted after 10 attempts on one part', async () => {
    const t = scriptedTransport(() => err(503, 'STORAGE_UNAVAILABLE'));
    const r = run(t.transport);
    r.s.start(upload(1, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.calls).toHaveLength(10);
    expect(r.last()).toMatchObject({ type: 'fatal', reason: 'retries_exhausted' });
  });

  it('honours Retry-After on 429 and signals waiting while nothing is sending', async () => {
    let calls = 0;
    const t = scriptedTransport(() => (++calls === 1 ? err(429, 'RATE_LIMITED', 7000) : 'ok'));
    const r = run(t.transport, fakeNet(), () => 0);
    r.s.start(upload(1, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(r.signals.find((x) => x.type === 'waiting')).toMatchObject({ retryAt: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(6900);
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.calls).toHaveLength(2);
  });

  it('stops sending while offline, without counting attempts, and resumes online', async () => {
    const t = scriptedTransport(() => 'ok', 50);
    const r = run(t.transport);
    r.s.start(upload(3, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(20);
    r.net.set(false);
    expect(t.calls[0]!.signal.aborted).toBe(true);
    expect(r.last()).toEqual({ type: 'offline' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(1);
    r.net.set(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.ok()).toEqual([1, 2, 3]);
    expect(r.signals.some((x) => x.type === 'online')).toBe(true);
  });

  it('reports network errors to the monitor and progress per part', async () => {
    let first = true;
    const t = scriptedTransport(() => (first ? ((first = false), net0()) : 'ok'));
    const r = run(t.transport);
    r.s.start(upload(1, { maxParallel: 1 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.net.errors).toBe(1);
    expect(r.signals.find((x) => x.type === 'part_retry')).toMatchObject({ n: 1, attempt: 1 });
    expect(r.signals.find((x) => x.type === 'part_progress')).toEqual({ type: 'part_progress', n: 1, sent: 1 });
  });
});
