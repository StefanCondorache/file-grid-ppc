import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import type { Logger } from '../src/log.ts';
import { createSimMetrics } from '../src/metrics.ts';
import { BoundedQueue } from '../src/queue.ts';
import { MeterFleet, seededRng } from '../src/readings.ts';
import type { Reading } from '../src/readings.ts';
import { Sender } from '../src/sender.ts';
import type { SenderOptions } from '../src/sender.ts';
import { TEST_API_KEY, memoryLogger, startFakeBackend, waitFor } from './helpers.ts';
import type { FakeBackend } from './helpers.ts';

let backend: FakeBackend;
let senders: Sender[] = [];

before(async () => {
  backend = await startFakeBackend();
});
after(async () => {
  await backend.close();
});
beforeEach(() => {
  for (const s of senders) s.stop();
  senders = [];
  backend.requests.length = 0;
  backend.stored.clear();
  backend.script.length = 0;
  backend.duplicateReceptions = 0;
  backend.fallback = undefined;
});

function setup(options: Partial<SenderOptions> & { log?: Logger } = {}) {
  const queue = new BoundedQueue<Reading>(1000);
  const metrics = createSimMetrics({
    ratePerS: () => 0,
    queueDepth: () => queue.depth,
    mode: () => 'normal',
    backpressure: () => false,
  });
  const sleeps: number[] = [];
  const sender = new Sender({
    backendUrl: backend.url,
    apiKey: TEST_API_KEY,
    batchMax: 50,
    flushIntervalMs: 60_000,
    duplicateRatio: 0,
    queue,
    metrics,
    log: silentLogger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  senders.push(sender);
  const fleet = new MeterFleet({ meterCount: 30, sequenceBase: 1, rng: seededRng(11) });
  const enqueue = (n: number): Reading[] => {
    const readings = Array.from({ length: n }, () => fleet.next(Date.now(), 'simulator'));
    for (const r of readings) assert.equal(queue.push(r), true);
    return readings;
  };
  return { queue, metrics, sender, sleeps, enqueue };
}

const ids = (i: number): string[] => (backend.requests[i]?.readings ?? []).map((r) => r.readingId);

describe('sender retries', () => {
  it('re-sends the same batch on 503, honouring Retry-After, until it is acknowledged', async () => {
    const { queue, metrics, sender, sleeps, enqueue } = setup();
    backend.script.push({ status: 503, headers: { 'Retry-After': '7' } }, { status: 503 });
    const readings = enqueue(20);
    sender.flush();
    await waitFor(() => queue.depth === 0);

    assert.equal(backend.requests.length, 3);
    assert.deepEqual(ids(0), readings.map((r) => r.readingId));
    assert.deepEqual(ids(1), ids(0));
    assert.deepEqual(ids(2), ids(0));
    assert.equal(sleeps[0], 7000, 'Retry-After: 7 waits 7 s');
    assert.ok((sleeps[1] ?? -1) >= 0 && (sleeps[1] ?? 0) <= 1000, 'second failure: full jitter in [0, 1 s]');
    assert.equal(metrics.retries.get(), 2);
    assert.equal(metrics.requests.get({ status: '503' }), 2);
    assert.equal(metrics.requests.get({ status: '200' }), 1);
    assert.equal(metrics.readingsSent.total(), 20);
    assert.equal(metrics.readingsAcked.total(), 20);
    assert.equal(backend.stored.size, 20);
  });

  it('sends the API key, JSON and a fresh 32-hex trace id on every attempt', async () => {
    const { queue, sender, enqueue } = setup();
    backend.script.push({ status: 503, headers: { 'Retry-After': '0' } });
    enqueue(5);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    const traceIds = backend.requests.map((r) => r.headers['x-trace-id']);
    assert.equal(new Set(traceIds).size, 2);
    for (const req of backend.requests) {
      assert.match(String(req.headers['x-trace-id']), /^[0-9a-f]{32}$/);
      assert.equal(req.headers['x-api-key'], TEST_API_KEY);
      assert.equal(req.headers['content-type'], 'application/json');
    }
  });

  it('retries the same batch after a network error', async () => {
    const { queue, metrics, sender, enqueue } = setup();
    backend.script.push('drop');
    enqueue(20);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(backend.requests.length, 2);
    assert.deepEqual(ids(1), ids(0));
    assert.equal(metrics.requests.get({ status: 'network' }), 1);
    assert.equal(metrics.readingsAcked.total(), 20);
  });

  it('retries the same batch after a request timeout', async () => {
    const { queue, metrics, sender, enqueue } = setup({ requestTimeoutMs: 150 });
    backend.script.push('hang');
    enqueue(20);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(backend.requests.length, 2);
    assert.deepEqual(ids(1), ids(0));
    assert.equal(metrics.requests.get({ status: 'network' }), 1);
    assert.equal(metrics.readingsAcked.total(), 20);
  });

  it('treats 429 and other 5xx as retryable', async () => {
    const { queue, metrics, sender, sleeps, enqueue } = setup();
    backend.script.push({ status: 429, headers: { 'Retry-After': '1' } }, { status: 500 }, { status: 502 });
    enqueue(10);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(backend.requests.length, 4);
    for (let i = 1; i < 4; i += 1) assert.deepEqual(ids(i), ids(0));
    assert.equal(sleeps[0], 1000);
    assert.equal(metrics.retries.get(), 3);
    assert.equal(metrics.readingsAcked.total(), 10);
  });

  it('pauses 10 s on 401/403 and then retries the same batch', async () => {
    const { log, lines } = memoryLogger();
    const { queue, metrics, sender, sleeps, enqueue } = setup({ log });
    backend.script.push({ status: 401 }, { status: 403 });
    enqueue(10);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.deepEqual(sleeps, [10_000, 10_000]);
    assert.equal(backend.requests.length, 3);
    assert.deepEqual(ids(2), ids(0));
    assert.equal(metrics.readingsAcked.total(), 10);
    assert.ok(lines.some((l) => l.includes('"level":"error"') && l.includes('METER_API_KEY')));
    assert.ok(lines.every((l) => !l.includes(TEST_API_KEY)), 'the key itself is never logged');
  });
});

describe('sender rejections', () => {
  for (const status of [400, 422]) {
    it(`drops a batch answered with ${status}, counts it as rejected and logs the trace id once`, async () => {
      const { log, lines } = memoryLogger();
      const { queue, metrics, sender, enqueue } = setup({ log });
      backend.script.push({ status, body: '{"code":"VALIDATION_FAILED"}' });
      enqueue(20);
      sender.flush();
      await waitFor(() => queue.depth === 0);
      assert.equal(backend.requests.length, 1, 'never retried');
      assert.equal(metrics.readingsRejected.get(), 20);
      assert.equal(metrics.readingsSent.total(), 20);
      assert.equal(metrics.readingsAcked.total(), 0);
      assert.equal(metrics.retries.get(), 0);
      const traceId = String(backend.requests[0]?.headers['x-trace-id']);
      const errors = lines.filter((l) => l.includes('"level":"error"'));
      assert.equal(errors.length, 1);
      assert.ok(errors[0]?.includes(traceId) && errors[0].includes('VALIDATION_FAILED'));
    });
  }
});

describe('sender logs', () => {
  it('logs the trace id as trace_id, the field name the backend uses, on every attempt', async () => {
    const { log, lines } = memoryLogger();
    const { queue, sender, enqueue } = setup({ log });
    backend.script.push({ status: 503, headers: { 'Retry-After': '0' } });
    enqueue(5);
    sender.flush();
    await waitFor(() => queue.depth === 0);

    const sent = backend.requests.map((r) => String(r.headers['x-trace-id']));
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const retry = entries.find((e) => e.message === 'backend did not accept meter batch, will retry');
    const acked = entries.find((e) => e.message === 'meter batch acknowledged');
    assert.equal(retry?.trace_id, sent[0]);
    assert.equal(acked?.trace_id, sent[1]);
    assert.equal(acked?.stored, 5, 'the acknowledgement counts are still logged');
    assert.ok(entries.every((e) => !('traceId' in e)), 'no camelCase traceId field');
  });
});

describe('sender counters', () => {
  it('counts sent once per unique reading and acked once per id, even when an ack is lost', async () => {
    const { queue, metrics, sender, enqueue } = setup();
    backend.script.push('store-then-503'); // stored, but the client sees 503 and re-sends
    enqueue(20);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(backend.requests.length, 2);
    assert.equal(backend.stored.size, 20);
    assert.equal(backend.duplicateReceptions, 20);
    assert.equal(metrics.readingsSent.total(), 20, 'the retry is not counted as sent');
    assert.equal(metrics.readingsAcked.total(), 20, 'the second 200 does not double count');
    assert.equal(metrics.backendDuplicates.get(), 20);
    assert.equal(metrics.retries.get(), 1);
  });

  it('counts per zone', async () => {
    const { queue, metrics, sender, enqueue } = setup();
    const readings = enqueue(30);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    for (const zone of ['muntenia', 'banat', 'dobrogea'] as const) {
      const expected = readings.filter((r) => r.zone === zone).length;
      assert.equal(metrics.readingsSent.get({ zone }), expected);
      assert.equal(metrics.readingsAcked.get({ zone }), expected);
    }
  });
});

describe('deliberate duplicates', () => {
  it('re-sends already acknowledged readings unchanged, without counting them as sent or acked', async () => {
    const { queue, metrics, sender, enqueue } = setup({ duplicateRatio: 0.3, rng: seededRng(12) });
    enqueue(50);
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(metrics.duplicatesSent.get(), 0, 'nothing acked yet, so the first batch has no duplicates');

    enqueue(150);
    await waitFor(() => {
      sender.flush();
      return queue.depth === 0;
    });

    const dupCount = metrics.duplicatesSent.get();
    assert.ok(dupCount > 0, 'some duplicates were sent');
    assert.equal(backend.duplicateReceptions, dupCount);
    assert.equal(metrics.backendDuplicates.get(), dupCount);
    assert.equal(metrics.readingsSent.total(), 200);
    assert.equal(metrics.readingsAcked.total(), 200);
    assert.equal(backend.stored.size, 200);

    const seen = new Map<string, string>();
    for (const req of backend.requests) {
      assert.ok(req.readings.length <= 50, 'duplicates never push a batch over BATCH_MAX');
      const inBatch = new Set(req.readings.map((r) => r.readingId));
      assert.equal(inBatch.size, req.readings.length, 'no id twice in the same batch');
      for (const r of req.readings) {
        const json = JSON.stringify(r);
        const first = seen.get(r.readingId);
        if (first !== undefined) assert.equal(json, first, `duplicate ${r.readingId} is byte-identical`);
        else seen.set(r.readingId, json);
      }
    }
  });

  it('sends no duplicates when DUPLICATE_RATIO is 0', async () => {
    const { queue, metrics, sender, enqueue } = setup({ duplicateRatio: 0 });
    for (let i = 0; i < 3; i += 1) {
      enqueue(50);
      sender.flush();
      await waitFor(() => queue.depth === 0);
    }
    assert.equal(metrics.duplicatesSent.get(), 0);
    assert.equal(backend.duplicateReceptions, 0);
  });
});

describe('sender batching and flow control', () => {
  it('sends full batches on notify and partial batches only on flush', async () => {
    const { queue, sender, enqueue } = setup({ batchMax: 10 });
    enqueue(5);
    sender.notify();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(backend.requests.length, 0, 'partial batch waits for the flush interval');
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(ids(0).length, 5);

    enqueue(25);
    sender.notify();
    await waitFor(() => queue.depth === 5);
    assert.deepEqual(
      backend.requests.slice(1).map((r) => r.readings.length),
      [10, 10],
    );
    sender.flush();
    await waitFor(() => queue.depth === 0);
    assert.equal(ids(3).length, 5);
  });

  it('keeps a failing batch at the head: no newer batch starts while it waits to be retried', async () => {
    let release: () => void = () => {};
    const { queue, sender, enqueue } = setup({
      batchMax: 10,
      sleep: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    backend.script.push({ status: 503 }, { delayMs: 100 }); // the second batch is acked after the first failed
    enqueue(30);
    sender.notify(); // starts two batches (max 2 in flight); the first to arrive gets 503
    await waitFor(() => backend.requests.length === 2);
    await waitFor(() => backend.stored.size === 10, 2000, 'second batch acked');
    await new Promise((r) => setTimeout(r, 50));
    sender.flush();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(backend.requests.length, 2, 'the third batch waits behind the failing one');
    assert.equal(queue.queued, 10);

    release();
    await waitFor(() => queue.depth === 0);
    assert.equal(backend.requests.length, 4);
    assert.deepEqual(ids(2), ids(0), 'the retry comes first');
  });

  it('never has more than two requests in flight', async () => {
    let maxActive = 0;
    const { queue, sender, enqueue } = setup({ batchMax: 5 });
    backend.fallback = () => undefined;
    enqueue(100);
    const probe = setInterval(() => (maxActive = Math.max(maxActive, sender.activeRequests)), 1);
    await waitFor(() => {
      sender.flush();
      maxActive = Math.max(maxActive, sender.activeRequests);
      return queue.depth === 0;
    });
    clearInterval(probe);
    assert.equal(maxActive, 2);
    assert.equal(backend.stored.size, 100);
  });

  it('drain() flushes everything that is queued', async () => {
    const { queue, sender, enqueue } = setup({ batchMax: 10 });
    enqueue(35);
    assert.equal(await sender.drain(3000), true);
    assert.equal(queue.depth, 0);
    assert.equal(backend.stored.size, 35);
  });

  it('stop() abandons a batch that is backing off, without further requests', async () => {
    const { sender, enqueue } = setup({ sleep: undefined, backoffBaseMs: 60_000, backoffCapMs: 60_000 });
    backend.fallback = () => ({ status: 503 });
    enqueue(5);
    sender.flush();
    await waitFor(() => backend.requests.length === 1);
    sender.stop();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(backend.requests.length, 1);
    assert.equal(sender.activeRequests, 0);
  });
});
