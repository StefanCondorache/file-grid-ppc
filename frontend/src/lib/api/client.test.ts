import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apiUrl } from './base';
import { api, unwrap } from './client';
import { ApiError } from './errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected a rejection');
}

describe('api client', () => {
  it('adds X-Requested-With only to mutations', async () => {
    const seen: Record<string, string | null> = {};
    server.use(
      http.get(apiUrl('/auth/me'), ({ request }) => { seen.get = request.headers.get('x-requested-with'); return HttpResponse.json({}); }),
      http.post(apiUrl('/auth/logout'), ({ request }) => { seen.post = request.headers.get('x-requested-with'); return new HttpResponse(null, { status: 204 }); }),
    );
    await api.GET('/auth/me');
    await api.POST('/auth/logout');
    expect(seen).toEqual({ get: null, post: 'filegrid' });
  });

  it('normalises the proposal error shape', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => HttpResponse.json(
      { code: 'VALIDATION_ERROR', message: 'x', traceId: 't9', fieldErrors: [{ field: 'username', code: 'required', message: 'y' }] }, { status: 422 })));
    const e = await rejection(unwrap(api.POST('/auth/login', { body: { username: '', password: '' } })));
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.traceId, e.fieldErrors.length]).toEqual([422, 'VALIDATION_ERROR', 't9', 1]);
  });

  it('normalises the NestJS envelope', async () => {
    server.use(http.get(apiUrl('/auth/me'), () => HttpResponse.json(
      { error: { code: 'unauthorized', message: 'Missing bearer token', trace_id: 't1', details: null } }, { status: 401 })));
    const e = await rejection(unwrap(api.GET('/auth/me')));
    expect([e.code, e.traceId]).toEqual(['UNAUTHORIZED', 't1']);
  });

  it('takes traceId from X-Trace-Id when the body has none', async () => {
    server.use(http.get(apiUrl('/auth/me'), () => new HttpResponse('boom', { status: 502, headers: { 'X-Trace-Id': 'h7' } })));
    const e = await rejection(unwrap(api.GET('/auth/me')));
    expect([e.status, e.traceId]).toEqual([502, 'h7']);
  });

  it('maps network failure to NETWORK', async () => {
    server.use(http.get(apiUrl('/auth/me'), () => HttpResponse.error()));
    const e = await rejection(unwrap(api.GET('/auth/me')));
    expect([e.status, e.code]).toEqual([0, 'NETWORK']);
  });
});
