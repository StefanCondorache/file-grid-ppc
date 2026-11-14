import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import { MAX_BODY_BYTES, createControlServer } from '../src/server.ts';
import { Simulator } from '../src/simulator.ts';
import { testConfig } from './helpers.ts';

let server: Server;
let sim: Simulator;
let base: string;

before(async () => {
  sim = new Simulator({ config: testConfig(), log: silentLogger, sequenceBase: 1 });
  server = createControlServer(sim, silentLogger);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  sim.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function put(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/control`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('control server', () => {
  it('GET /healthz answers ok', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('GET /control returns the status', async () => {
    const res = await fetch(`${base}/control`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), {
      mode: 'normal',
      ratePerS: 10,
      normalRatePerS: 10,
      peakRatePerS: 100,
      queueDepth: 0,
      stormEndsAt: null,
      sentUnique: 0,
      ackedUnique: 0,
    });
  });

  it('PUT /control applies a timed storm and a custom rate (query string ignored)', async () => {
    const storm = await put(JSON.stringify({ mode: 'peak', durationS: 120 }));
    assert.equal(storm.status, 200);
    assert.equal(storm.json.mode, 'peak');
    assert.equal(storm.json.ratePerS, 100);
    assert.ok(typeof storm.json.stormEndsAt === 'string' && Date.parse(storm.json.stormEndsAt) > Date.now());

    const res = await fetch(`${base}/control?x=1`, { method: 'PUT', body: JSON.stringify({ mode: 'custom', ratePerS: 5000 }) });
    const custom = (await res.json()) as Record<string, unknown>;
    assert.equal(custom.mode, 'custom');
    assert.equal(custom.ratePerS, 1000, 'capped at MAX_RATE');
    assert.equal(custom.stormEndsAt, null);
    assert.equal(((await (await fetch(`${base}/control`)).json()) as Record<string, unknown>).mode, 'custom');

    await put(JSON.stringify({ mode: 'normal' }));
  });

  it('PUT /control rejects bad input with 400 VALIDATION_FAILED', async () => {
    for (const body of ['not json', '[]', '{"mode":"storm"}', '{"mode":"custom"}', '{"mode":"peak","durationS":4000}']) {
      const res = await put(body);
      assert.equal(res.status, 400, body);
      assert.equal(res.json.code, 'VALIDATION_FAILED');
      assert.equal(typeof res.json.message, 'string');
    }
    assert.equal(sim.status().mode, 'normal', 'a rejected update changes nothing');
  });

  it('PUT /control refuses bodies over 4 KiB', async () => {
    const big = JSON.stringify({ mode: 'peak', pad: 'x'.repeat(MAX_BODY_BYTES) });
    const res = await put(big);
    assert.equal(res.status, 413);
    assert.equal(res.json.code, 'PAYLOAD_TOO_LARGE');
  });

  it('refuses an oversized chunked body (no Content-Length) too', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/control`, { method: 'PUT', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      for (let i = 0; i < 10; i += 1) req.write('x'.repeat(1024));
      req.end();
    });
    assert.equal(status, 413);
  });

  it('GET /metrics serves the Prometheus text format', async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    assert.ok(text.includes('# TYPE filegrid_sim_readings_sent_total counter'));
    assert.ok(text.includes('filegrid_sim_mode{mode="normal"} 1'));
  });

  it('answers unknown paths with 404 JSON and wrong methods with 405', async () => {
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as Record<string, unknown>).code, 'NOT_FOUND');
    const proto = await fetch(`${base}/__proto__`);
    assert.equal(proto.status, 404);
    const wrong = await fetch(`${base}/metrics`, { method: 'POST' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
    await wrong.body?.cancel();
  });
});
