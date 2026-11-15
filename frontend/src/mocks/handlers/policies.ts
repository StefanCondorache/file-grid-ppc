import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Policy, UserRef } from '@/lib/api/types';
import { db } from '../db';
import { CAPABILITIES } from '../seed/auth';
import { scenario } from '../scenario';
import { currentSession, touchSession, userById } from '../session';
import { policyReadHandlers, policyView } from './uploads';

type Change = { field: string; from: string | null; to: string | null };
type VersionRow = { category: string; version: number; policy: unknown; changedAt: string; changedBy: UserRef; changes: Change[] };

const LEGACY: Record<string, string> = { fault_records: 'fault', connection_documents: 'connection', drone_videos: 'drone', meter_readings: 'meter' };
const STORAGES = ['s3', 'ftp', 'db'];
const trace = () => `mock-${crypto.randomUUID().slice(0, 8)}`;

function fail(status: number, code: string, message: string, extras: Record<string, unknown> = {}): Response {
  const traceId = trace();
  return HttpResponse.json({ code, message, traceId, ...extras }, { status, headers: { 'X-Trace-Id': traceId } });
}

const TRACKED = ['primaryStorage', 'fallbackStorage', 'encryptionAtRest', 'chunkSize', 'maxParallel', 'maxConcurrency'] as const;

const putHandler = http.put(apiUrl('/policies/:category'), async ({ params, request }) => {
  const session = currentSession();
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  if (request.headers.get('X-Requested-With') !== 'filegrid') return fail(403, 'CSRF_REJECTED', 'Cererea nu are antetul anti-CSRF.');
  touchSession();
  if (!(CAPABILITIES[session.activeRole] as string[]).includes('edit_policies')) return fail(403, 'FORBIDDEN', 'Rolul nu poate modifica politicile.');
  const category = String(params.category);
  const current = policyView(category);
  if (!current) return fail(404, 'NOT_FOUND', 'Categoria nu există.');
  const body = (await request.json()) as Record<string, unknown>;
  if (body.baseVersion !== current.version) {
    return fail(409, 'POLICY_VERSION_CONFLICT', 'Politica a fost modificată între timp.', { currentPolicy: current });
  }
  const mib = 1024 * 1024;
  const chunk = Number(body.chunkSize);
  const par = Number(body.maxParallel);
  const fb = (body.fallbackStorage ?? null) as string | null;
  if (!STORAGES.includes(String(body.primaryStorage)) || (fb !== null && !STORAGES.includes(fb)) || fb === body.primaryStorage || !(chunk >= mib && chunk <= 32 * mib) || !(par >= 1 && par <= 6)) {
    return fail(422, 'VALIDATION_ERROR', 'Valorile politicii nu sunt valide.');
  }
  if (current.encryptionLocked && body.encryptionAtRest !== true) return fail(422, 'ENCRYPTION_LOCKED', 'Criptarea nu poate fi dezactivată.');
  const next = {
    ...current,
    version: current.version + 1,
    primaryStorage: body.primaryStorage as typeof current.primaryStorage,
    fallbackStorage: fb as typeof current.fallbackStorage,
    encryptionAtRest: Boolean(body.encryptionAtRest),
    chunkSize: chunk,
    maxParallel: par,
    maxConcurrency: body.maxConcurrency === undefined ? current.maxConcurrency : Number(body.maxConcurrency),
    updatedAt: new Date().toISOString(),
    updatedBy: userById(session.realUserId)!,
  };
  const changes: Change[] = TRACKED.filter((k) => String(current[k] ?? '') !== String(next[k] ?? '')).map((k) => ({
    field: k, from: current[k] == null ? null : String(current[k]), to: next[k] == null ? null : String(next[k]),
  }));
  // The shared db keeps the proposal's ids (fault, S3); the read handlers translate them to the real format.
  db.policies.put({
    ...(next as unknown as Policy),
    category: (LEGACY[category] ?? category) as Policy['category'],
    primaryStorage: next.primaryStorage.toUpperCase() as Policy['primaryStorage'],
    fallbackStorage: next.fallbackStorage ? (next.fallbackStorage.toUpperCase() as Policy['fallbackStorage']) : null,
  });
  db.insert<VersionRow & Record<string, unknown>>('policyVersions', { category, version: next.version, policy: next, changedAt: next.updatedAt, changedBy: next.updatedBy, changes });
  // Audited like the backend (action policy_update, the changed fields as details).
  const traceId = trace();
  const actor = userById(session.realUserId)!;
  db.audit.append({
    actor, actingAs: session.activeRole === actor.role ? null : session.activeRole, demo: false, action: 'policy_update', category, traceId,
    details: changes.map((c) => `${c.field}: ${c.from ?? '–'} → ${c.to ?? '–'}`).join(', '),
  });
  scenario.emit('policy.updated', { category, version: next.version });
  return HttpResponse.json(next, { headers: { 'X-Trace-Id': traceId } });
});

const versionsHandler = http.get(apiUrl('/policies/:category/versions'), ({ params }) => {
  if (!currentSession()) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  const rows = db.list<VersionRow>('policyVersions').filter((r) => r.category === params.category).sort((a, b) => b.version - a.version);
  return HttpResponse.json({ data: rows.map((r) => ({ version: r.version, policy: r.policy, changedAt: r.changedAt, changedBy: r.changedBy, changes: r.changes })) }, { headers: { 'X-Trace-Id': trace() } });
});

export const policyHandlers = [putHandler, versionsHandler, ...policyReadHandlers];
