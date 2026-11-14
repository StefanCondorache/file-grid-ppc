// End to end: the whole simulator runs for ~5 s against an in-process fake backend that fails on purpose
// (503, 429, dropped connections, lost acks). Every reading sent must end up stored exactly once.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import { seededRng } from '../src/readings.ts';
import { Simulator } from '../src/simulator.ts';
import { TEST_API_KEY, startFakeBackend, testConfig, waitFor } from './helpers.ts';
import type { FakeBackend, Scripted } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** About 1 in 5 requests fails in some way; the rest are stored and acknowledged normally. */
function chaos(backend: FakeBackend, seed: number): void {
  const rng = seededRng(seed);
  backend.fallback = (): Scripted | undefined => {
    const x = rng();
    if (x < 0.08) return { status: 503, headers: { 'Retry-After': '0' } };
    if (x < 0.11) return { status: 429 };
    if (x < 0.14) return 'drop';
    if (x < 0.17) return 'store-then-503';
    if (x < 0.2) return { status: 500 };
    return undefined;
  };
}

function assertNoLossNoDuplicates(backend: FakeBackend, sent: number, acked: number): void {
  const unique = new Set(backend.requests.flatMap((r) => r.readings.map((x) => x.readingId)));
  assert.ok(sent > 0);
  assert.equal(acked, sent, 'every unique reading sent was acknowledged');
  assert.equal(backend.stored.size, sent, 'the backend stored each unique reading exactly once');
  assert.equal(unique.size, sent, 'no reading id the simulator did not count as sent');
}

describe('end to end against a flaky fake backend', () => {
  it('runs ~5 s with a storm, retries and duplicates, and loses nothing', async () => {
    const backend = await startFakeBackend();
    chaos(backend, 31);
    const sim = new Simulator({
      config: testConfig({
        backendUrl: backend.url,
        meterRate: 150,
        stormFactor: 4,
        batchMax: 50,
        flushIntervalMs: 100,
        duplicateRatio: 0.05,
        maxQueue: 20_000,
      }),
      log: silentLogger,
      sender: { backoffBaseMs: 10, backoffCapMs: 100, requestTimeoutMs: 2000 },
    });
    try {
      sim.start();
      await new Promise((r) => setTimeout(r, 1500));
      sim.applyControl({ mode: 'peak', durationS: 2 });
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal(sim.status().mode, 'normal', 'the 2 s storm ended by itself');
      assert.equal(await sim.shutdown(5000), true, 'queue fully drained on shutdown');

      const m = sim.metrics;
      assertNoLossNoDuplicates(backend, m.readingsSent.total(), m.readingsAcked.total());
      const sent = m.readingsSent.total();
      // ~1.5 s + ~1.5 s at 150/s and 2 s at 600/s ~ 1650 readings (timer jitter allowed)
      assert.ok(sent > 1100 && sent < 2100, `sent ${sent}`);
      assert.equal(m.readingsRejected.total(), 0);
      assert.ok(m.retries.total() > 0, 'chaos caused retries');
      assert.ok(m.duplicatesSent.total() > 0, 'deliberate duplicates were sent');
      assert.ok(backend.duplicateReceptions >= m.duplicatesSent.total());
      const origins = new Set([...backend.stored.values()].map((r) => r.origin));
      assert.deepEqual([...origins].sort(), ['simulator', 'storm']);
      assert.equal(sim.queue.depth, 0);
    } finally {
      sim.stop();
      await backend.close();
    }
  });
});

describe('node src/main.ts as a process', () => {
  it('starts, serves control and metrics, flushes on SIGTERM and exits 0 without logging the key', async () => {
    const backend = await startFakeBackend();
    chaos(backend, 32);
    const child = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH ?? '',
        BACKEND_URL: backend.url,
        METER_API_KEY: TEST_API_KEY,
        METER_RATE: '100',
        PORT: '0',
        FLUSH_INTERVAL_MS: '100',
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      await waitFor(() => stdout.includes('control server listening'), 5000, 'startup');
      const startLine = stdout.split('\n').find((l) => l.includes('control server listening')) ?? '';
      const port = (JSON.parse(startLine) as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
      const put = await fetch(`${base}/control`, { method: 'PUT', body: JSON.stringify({ mode: 'peak', durationS: 1 }) });
      assert.equal(((await put.json()) as { mode: string }).mode, 'peak');
      await new Promise((r) => setTimeout(r, 2500));
      const metrics = await (await fetch(`${base}/metrics`)).text();
      assert.match(metrics, /^filegrid_sim_readings_sent_total\{zone="muntenia"\} [1-9]\d*$/m);
      assert.match(metrics, /^filegrid_sim_mode\{mode="normal"\} 1$/m);

      child.kill('SIGTERM');
      assert.equal(await exited, 0, stderr);
    } finally {
      child.kill('SIGKILL');
      await backend.close();
    }

    const lines = stdout.trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>); // every line is JSON
    assert.ok(!stdout.includes(TEST_API_KEY) && !stderr.includes(TEST_API_KEY), 'API key never logged');
    assert.ok(entries.every((e) => typeof e.level === 'string' && typeof e.time === 'string' && typeof e.message === 'string'));
    const summary = entries.filter((e) => e.message === 'simulator summary').at(-1);
    assert.ok(summary, 'a final summary line is logged on shutdown');
    assertNoLossNoDuplicates(backend, Number(summary.sent), Number(summary.acked));
    assert.equal(summary.queueDepth, 0);
  });

  it('exits 1 with a clear message when METER_API_KEY is missing', async () => {
    const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    assert.equal(code, 1);
    const entry = JSON.parse(stderr.trim()) as { level: string; problems: string[] };
    assert.equal(entry.level, 'error');
    assert.deepEqual(entry.problems, ['METER_API_KEY is required']);
  });
});
