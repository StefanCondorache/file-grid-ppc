import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Capability } from '@/lib/api/types';
import type { MatrixWindow, SeriesWindow } from '@/lib/monitoring/contract';
import { scenario } from '../scenario';
import { CAPABILITIES } from '../seed/auth';
import { currentSession, touchSession, userById } from '../session';

/**
 * The monitoring group of the real backend (docs/api.md "Monitoring and traces"; backend/src/guarantees and
 * monitoring), answered from the scenario: guarantees, alerts, storage health, the metrics matrix and the bulkhead.
 * Reads do not refresh the session (the backend's @NoSessionRefresh); reading starts the scenario clock.
 */
const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;

function reply(body: unknown): Response {
  return HttpResponse.json(body as never, { headers: { 'X-Trace-Id': trace() } });
}

function fail(status: number, code: string, message: string, extras: Record<string, unknown> = {}): Response {
  const traceId = trace();
  return HttpResponse.json({ code, message, traceId, ...extras }, { status, headers: { 'X-Trace-Id': traceId } });
}

const invalid = (field: string) =>
  fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.', { fieldErrors: [{ field, code: 'invalid_value', message: 'Valoare nepermisă.' }] });

type Session = NonNullable<ReturnType<typeof currentSession>>;

/** 401 without a session, 403 without the capability; otherwise the session (and the clock runs). */
function gate(capability?: Capability): Session | Response {
  const session = currentSession();
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  if (capability && !CAPABILITIES[session.activeRole].includes(capability)) {
    return fail(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
  }
  scenario.start();
  return session;
}

/** A query value from a fixed set, its default when absent, or null when invalid. */
function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T | null {
  if (raw === null) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function int(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export const monitoringHandlers = [
  http.get(apiUrl('/guarantees'), () => {
    const s = gate();
    return s instanceof Response ? s : reply({ data: scenario.guarantees() });
  }),

  http.get(apiUrl('/alerts'), ({ request }) => {
    const s = gate();
    if (s instanceof Response) return s;
    const q = new URL(request.url).searchParams;
    const state = oneOf(q.get('state'), ['active', 'resolved', 'all'] as const, 'active');
    const page = int(q.get('page'), 1, 1, 1_000_000);
    const pageSize = int(q.get('pageSize'), 50, 1, 200);
    if (state === null) return invalid('state');
    if (page === null) return invalid('page');
    if (pageSize === null) return invalid('pageSize');
    const all = scenario.alerts(state);
    return reply({
      data: all.slice((page - 1) * pageSize, page * pageSize),
      meta: { page, pageSize, total: all.length, hasMore: page * pageSize < all.length },
    });
  }),

  http.post(apiUrl('/alerts/:alertId/acknowledge'), ({ request, params }) => {
    const s = gate();
    if (s instanceof Response) return s;
    if (request.headers.get('X-Requested-With') !== 'filegrid') return fail(403, 'CSRF_REJECTED', 'Cererea nu are antetul anti-CSRF.');
    touchSession();
    const realUser = userById(s.realUserId)!;
    const alert = scenario.acknowledge(String(params.alertId), realUser, s.activeRole === realUser.role ? null : s.activeRole);
    return alert ? reply(alert) : fail(404, 'NOT_FOUND', 'Alerta nu există.');
  }),

  http.get(apiUrl('/storage-health'), () => {
    const s = gate();
    return s instanceof Response ? s : reply({ data: scenario.storageHealth() });
  }),

  http.get(apiUrl('/metrics/matrix'), ({ request }) => {
    const s = gate('view_observability');
    if (s instanceof Response) return s;
    const window = oneOf<MatrixWindow>(new URL(request.url).searchParams.get('window'), ['5m', '1h', '24h'], '5m');
    return window === null ? invalid('window') : reply(scenario.matrix(window));
  }),

  http.get(apiUrl('/metrics/bulkhead'), ({ request }) => {
    const s = gate('view_observability');
    if (s instanceof Response) return s;
    const window = oneOf<SeriesWindow>(new URL(request.url).searchParams.get('window'), ['5m', '15m', '1h'], '15m');
    return window === null ? invalid('window') : reply(scenario.bulkhead(window));
  }),
];
