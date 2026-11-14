import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import { CATEGORY_IDS, type Alert } from '@/lib/monitoring/contract';
import { db } from '../db';
import { scenario } from '../scenario';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'monitoring'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  scenario.reset();
});
afterEach(() => scenario.stop());

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
const get = async (p: string) => {
  const res = await fetch(url(p));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { data: unknown[] } };
};
const ack = (id: string, headers: Record<string, string> = { 'X-Requested-With': 'filegrid' }) =>
  fetch(url(`/alerts/${id}/acknowledge`), { method: 'POST', headers });

describe('monitoring mock', () => {
  it('serves guarantees, storage health and alerts in the real contract shape to every role', async () => {
    await login('teren');
    const guarantees = await get('/guarantees');
    expect(guarantees.status).toBe(200);
    expect(guarantees.body.data.map((g) => (g as { category: string; state: string }).category)).toEqual([...CATEGORY_IDS]);
    expect((await get('/storage-health')).body.data).toEqual(['s3', 'ftp', 'db'].map((storage) => expect.objectContaining({ storage, status: 'ok', circuitState: 'closed' })));
    expect((await get('/alerts')).body).toEqual({ data: [], meta: { page: 1, pageSize: 50, total: 0, hasMore: false } });
    const all = await get('/alerts?state=all');
    expect(all.body.data).toEqual([expect.objectContaining({ category: 'fault_records', state: 'resolved' })]);
    expect((await get('/alerts?state=soon')).status).toBe(422);
  });

  it('answers 401 without a session', async () => {
    const res = await get('/guarantees');
    expect(res).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
  });

  it('metrics need view_observability and follow the scenario', async () => {
    await login('teren');
    expect((await get('/metrics/matrix')).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await get('/metrics/bulkhead')).status).toBe(403);

    await login('admin');
    const matrix = await get('/metrics/matrix?window=1h');
    expect(matrix.status).toBe(200);
    expect(matrix.body).toMatchObject({ window: '1h' });
    expect(matrix.body.cells).toHaveLength(12);
    expect((await get('/metrics/matrix?window=7d')).body).toMatchObject({ code: 'VALIDATION_ERROR' });
    const bulkhead = await get('/metrics/bulkhead');
    expect(bulkhead.body).toMatchObject({ window: '15m', stepS: 2 });
    expect(bulkhead.body.series).toHaveLength(4);
    expect(bulkhead.body.data).toHaveLength(4);
  });

  it('acknowledge records who and when, once, in the audit trail', async () => {
    await login('dispecerat');
    scenario.startStorm('fault_records', 10, 60);
    for (let i = 0; i < 3; i++) scenario.tick();
    const [alert] = (await get('/alerts')).body.data as Alert[];
    expect(alert).toMatchObject({ category: 'fault_records', state: 'at_risk', acknowledgedAt: null });

    expect((await ack(alert!.id, {})).status).toBe(403);
    const first = (await (await ack(alert!.id)).json()) as Alert;
    expect(first).toMatchObject({ id: alert!.id, acknowledgedBy: { username: 'dispecerat', displayName: 'Elena Marin', role: 'dispecerat' } });
    expect(first.acknowledgedAt).toEqual(expect.any(String));
    const again = (await (await ack(alert!.id)).json()) as Alert;
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    expect(db.list<{ action: string }>('audit').filter((a) => a.action === 'alert_ack')).toHaveLength(1);
    expect((await ack('00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
});

describe('scenario in the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is exposed as window.__fgScenario in development only', async () => {
    const w = window as unknown as { __fgScenario?: unknown };
    expect(w.__fgScenario).toBeUndefined();
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const fresh = await import('../scenario');
    expect(w.__fgScenario).toBe(fresh.scenario);
    fresh.scenario.stop();
    delete w.__fgScenario;
  });
});
