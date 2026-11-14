import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Capability } from '@/lib/api/types';
import { CATEGORY_IDS } from '@/lib/monitoring/contract';
import { db } from '../db';
import { scenario, toStorageId } from '../scenario';
import { CAPABILITIES } from '../seed/auth';
import { currentSession, mockSettings, userById } from '../session';

/**
 * Demo controls of the real backend (backend/src/demo, meters.controller PUT /meters/simulator): 404 when demo mode is
 * off, admin only (`demo_controls`), every action audited. Answered from the scenario so the effect shows everywhere.
 */
const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const reply = (body: unknown, status = 200) => HttpResponse.json(body as never, { status, headers: { 'X-Trace-Id': trace() } });
const fail = (status: number, code: string, message: string) => reply({ code, message, traceId: trace() }, status);

/** Max storm multiplier the mock accepts (the backend uses the simulator's STORM_FACTOR, 10). */
export const MAX_STORM_FACTOR = 20;

type Session = NonNullable<ReturnType<typeof currentSession>>;

/** 404 with demo mode off, 401 without a session, 403 without the capability. */
export function demoGate(capability: Capability = 'demo_controls'): Session | Response {
  if (!(mockSettings().demoMode ?? true)) return fail(404, 'NOT_FOUND', 'Mod demo oprit.');
  const s = currentSession();
  if (!s) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  if (!CAPABILITIES[s.activeRole].includes(capability)) return fail(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
  scenario.start();
  return s;
}

export function audit(s: Session, action: string, details: string, extra: Record<string, unknown> = {}): void {
  db.audit.append({ actor: userById(s.realUserId), actingAs: null, demo: true, action, outcome: 'success', details, traceId: trace(), ...extra });
}

function status() {
  const sim = scenario.simulator();
  const storm = scenario.storms().find((x) => x.category === 'meter_readings');
  const storages = Object.fromEntries(scenario.storageHealth().map((h) => [h.storage, { up: h.status !== 'down', circuit: h.circuitState }]));
  return { demoMode: true, simulator: sim, storm: storm ? { category: 'meter_readings', endsAt: storm.endsAt } : null, storages };
}

export const demoHandlers = [
  http.get(apiUrl('/demo/status'), () => {
    const s = demoGate();
    return s instanceof Response ? s : reply(status());
  }),

  http.post(apiUrl('/demo/storms'), async ({ request }) => {
    const s = demoGate();
    if (s instanceof Response) return s;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { category?: string; durationS?: number; factor?: number };
    const category = body.category ?? 'meter_readings';
    const durationS = body.durationS ?? 300;
    const factor = body.factor ?? 10;
    if (!(CATEGORY_IDS as readonly string[]).includes(category) || !Number.isInteger(durationS) || durationS < 10 || durationS > 3600 || !(factor >= 1 && factor <= MAX_STORM_FACTOR)) {
      return fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.');
    }
    if (scenario.storms().some((x) => x.category === category)) return fail(409, 'STORM_ALREADY_RUNNING', 'O furtună rulează deja.');
    scenario.startStorm(category as (typeof CATEGORY_IDS)[number], factor, durationS);
    audit(s, 'storm_start', `${category} x${factor} ${durationS}s`);
    return reply(scenario.simulator(), 201);
  }),

  http.delete(apiUrl('/demo/storms/:category'), ({ params }) => {
    const s = demoGate();
    if (s instanceof Response) return s;
    const category = String(params.category);
    if ((CATEGORY_IDS as readonly string[]).includes(category)) scenario.stopStorm(category as (typeof CATEGORY_IDS)[number]);
    audit(s, 'storm_stop', category);
    return reply(scenario.simulator());
  }),

  http.post(apiUrl('/demo/corruptions'), async ({ request }) => {
    const s = demoGate();
    if (s instanceof Response) return s;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { fileId?: string };
    if (typeof body.fileId !== 'string') return fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.');
    const done = scenario.corrupt(body.fileId);
    if (!done) return fail(404, 'NOT_FOUND', 'Fișierul nu există.');
    audit(s, 'file_corrupted', `demo: byte flipped on ${done.storage}`, { fileId: body.fileId });
    return reply(done, 201);
  }),

  http.post(apiUrl('/demo/storages/:storage/:action'), ({ params }) => {
    const s = demoGate();
    if (s instanceof Response) return s;
    const storage = String(params.storage);
    const action = String(params.action);
    if (!['s3', 'ftp', 'db'].includes(storage) || !['stop', 'start'].includes(action)) return fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.');
    if (storage === 'db') return fail(422, 'VALIDATION_ERROR', 'PostgreSQL ține și metadatele; opriți S3 sau FTP.');
    const running = action === 'start';
    scenario.setStorage(toStorageId(storage), running);
    audit(s, running ? 'storage_start' : 'storage_stop', storage);
    return reply({ storage, running, replicas: running ? 1 : 0 });
  }),
];
