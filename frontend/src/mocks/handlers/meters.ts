import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Capability } from '@/lib/api/types';
import { ZONES, type SimulatorMode } from '@/lib/monitoring/contract';
import { scenario } from '../scenario';
import { CAPABILITIES } from '../seed/auth';
import { currentSession } from '../session';
import { audit, demoGate } from './demo';

/** The meters group of the real backend (backend/src/meters): counters, simulator, readings list. */
const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const reply = (body: unknown, status = 200) => HttpResponse.json(body as never, { status, headers: { 'X-Trace-Id': trace() } });
const fail = (status: number, code: string, message: string) => reply({ code, message, traceId: trace() }, status);

function gate(capability: Capability): Response | null {
  const s = currentSession();
  if (!s) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  if (!CAPABILITIES[s.activeRole].includes(capability)) return fail(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
  scenario.start();
  return null;
}

const MODES: readonly SimulatorMode[] = ['normal', 'peak', 'custom', 'stopped'];

/** A stable id per batch file, so a reading links to the same file detail every time. */
const batchFileId = (n: number) => `00000000-0000-4000-8000-${String(100000000000 + n).slice(-12)}`;

/** The newest readings, synthesised from the counters (one JSONL batch file per 10 readings). */
function recentReadings(pageSize: number) {
  const counters = scenario.counters();
  const at = Date.parse(counters.at);
  return Array.from({ length: pageSize }, (_, i) => {
    const sequence = counters.unique - i;
    const zone = ZONES[sequence % ZONES.length]!;
    return {
      fileId: batchFileId(Math.floor(sequence / 10)),
      meterId: `CTR-${String(1000 + (sequence % 250)).padStart(5, '0')}`,
      zone,
      readingTime: new Date(at - i * 400 - 1500).toISOString(),
      kwh: Math.round((0.2 + ((sequence * 37) % 100) / 40) * 1000) / 1000,
      sequence,
      receivedAt: new Date(at - i * 400).toISOString(),
      storage: 'db',
      origin: scenario.simulator().mode === 'peak' ? 'storm' : 'simulator',
    };
  });
}

export const meterHandlers = [
  http.get(apiUrl('/meters/counters'), () => gate('view_meters') ?? reply(scenario.counters())),

  http.get(apiUrl('/meters/simulator'), () => gate('view_meters') ?? reply(scenario.simulator())),

  http.put(apiUrl('/meters/simulator'), async ({ request }) => {
    const s = demoGate();
    if (s instanceof Response) return s;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { mode?: SimulatorMode; ratePerS?: number | null };
    if (!body.mode || !MODES.includes(body.mode) || (body.mode === 'custom' && typeof body.ratePerS !== 'number')) {
      return fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.');
    }
    const status = scenario.setSimulator(body.mode, body.ratePerS ?? undefined);
    audit(s, 'simulator_rate', `${body.mode}${body.ratePerS ? ` ${body.ratePerS}/s` : ''}`, { category: 'meter_readings' });
    return reply(status);
  }),

  http.get(apiUrl('/meter-readings'), ({ request }) => {
    const denied = gate('view_meters');
    if (denied) return denied;
    const pageSize = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('pageSize') ?? 20) || 20));
    const data = recentReadings(pageSize);
    return reply({ data, meta: { page: 1, pageSize, total: scenario.counters().unique, hasMore: true } });
  }),
];
