import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { scenario } from '../scenario';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'monitoring', 'meters', 'demo'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  scenario.reset();
  localStorage.removeItem('fg.mock');
});
afterEach(() => {
  scenario.stop();
  localStorage.removeItem('fg.mock');
});

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
const send = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(url(p), { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'filegrid' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const auditActions = () => db.list<{ action: string; demo?: boolean }>('audit').filter((a) => a.demo).map((a) => a.action);

describe('demo and meter mocks', () => {
  it('answers 404 on every demo endpoint when demo mode is off', async () => {
    await login('admin');
    localStorage.setItem('fg.mock', JSON.stringify({ demoMode: false }));
    expect((await send('GET', '/demo/status')).status).toBe(404);
    expect((await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 60 })).status).toBe(404);
    expect((await send('PUT', '/meters/simulator', { mode: 'peak' })).status).toBe(404);
  });

  it('refuses non-admin roles and invalid storms', async () => {
    await login('dispecerat');
    expect((await send('GET', '/demo/status')).status).toBe(403);
    await login('admin');
    expect((await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 60, factor: 25 })).status).toBe(422);
    expect((await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 5 })).status).toBe(422);
  });

  it('starts and stops a meter storm, and the simulator peak raises ratePerS', async () => {
    await login('admin');
    const before = (await send('GET', '/meters/simulator')).body.ratePerS as number;
    const started = await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 60 });
    expect(started.status).toBe(201);
    expect(started.body.ratePerS as number).toBeGreaterThan(before);
    expect((await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 60 })).status).toBe(409);
    expect((await send('GET', '/demo/status')).body.storm).toEqual(expect.objectContaining({ category: 'meter_readings' }));
    expect((await send('DELETE', '/demo/storms/meter_readings')).body.ratePerS).toBe(before);

    const peak = await send('PUT', '/meters/simulator', { mode: 'peak' });
    expect(peak.body.ratePerS as number).toBeGreaterThan(before);
    expect((await send('PUT', '/meters/simulator', { mode: 'normal' })).body.ratePerS).toBe(before);
  });

  it('stops and starts S3, refuses db, and audits every action', async () => {
    await login('admin');
    expect((await send('POST', '/demo/storages/s3/stop')).body).toEqual({ storage: 's3', running: false, replicas: 0 });
    expect(scenario.storageHealth().find((h) => h.storage === 's3')?.status).toBe('down');
    expect((await send('POST', '/demo/storages/db/stop')).status).toBe(422);
    await send('POST', '/demo/storages/s3/start');
    expect(scenario.storageHealth().find((h) => h.storage === 's3')?.status).toBe('ok');
    await send('POST', '/demo/storms', { category: 'meter_readings', durationS: 60 });
    await send('PUT', '/meters/simulator', { mode: 'normal' });
    expect(auditActions()).toEqual(['storage_stop', 'storage_start', 'storm_start', 'simulator_rate']);
  });

  it('serves counters and recent readings', async () => {
    await login('dispecerat');
    const counters = await send('GET', '/meters/counters');
    expect(counters.body).toEqual(expect.objectContaining({ received: expect.any(Number), lost: 0 }));
    const readings = await send('GET', '/meter-readings?pageSize=5');
    expect((readings.body.data as unknown[]).length).toBe(5);
    expect((readings.body.data as Record<string, unknown>[])[0]).toEqual(expect.objectContaining({ fileId: expect.any(String), zone: expect.any(String) }));
  });
});
