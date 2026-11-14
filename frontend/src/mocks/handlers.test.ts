import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { pathGroup } from './groups';
import { buildHandlers } from './handlers';

describe('pathGroup', () => {
  it('maps every path root', () => {
    const cases: Record<string, string> = {
      '/files/x/content': 'files', '/traces/t': 'files', '/stream': 'stream', '/ping': 'uploads',
      '/uploads/u/parts/1': 'uploads', '/meter-readings': 'meters', '/meters/counters': 'meters',
      '/guarantees': 'monitoring', '/alerts': 'monitoring', '/storage-health': 'monitoring', '/metrics/matrix': 'monitoring',
      '/audit-events': 'audit', '/statistics/periods': 'statistics', '/demo/status': 'demo',
      '/demo/acting-role': 'demo', '/auth/me': 'auth', '/policies/fault': 'policies',
    };
    for (const [path, group] of Object.entries(cases)) expect([path, pathGroup(path)]).toEqual([path, group]);
  });
});

describe('buildHandlers', () => {
  const marker = http.get(apiUrl('/statistics/periods'), () => HttpResponse.json({ data: [], marker: true }));
  const server = setupServer();
  beforeAll(async () => {
    server.use(...(await buildHandlers('all', { statistics: [marker] })));
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterAll(() => server.close());

  it('serves every proposal path from the baseline', async () => {
    // A group no slice of this wave hand-writes (monitoring is hand-written since 6e.1).
    const res = await fetch(new URL(apiUrl('/audit-events'), location.origin));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('data');
  });

  it('hand-written handlers win over the baseline', async () => {
    const res = await fetch(new URL(apiUrl('/statistics/periods'), location.origin));
    expect(await res.json()).toMatchObject({ marker: true });
  });

  it('never lets the baseline answer inside a hand-written group', async () => {
    const res = await fetch(new URL(apiUrl('/statistics/storage-fit'), location.origin));
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 'NOT_MOCKED' });
  });
});
