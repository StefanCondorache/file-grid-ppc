import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import { POLICY_CATEGORIES, toCategory, toPolicy, toStorage, type PolicyCategory, type PolicyChange, type PolicyDoc } from '@/features/policies/types';
import { db } from '../db';
import { scenario } from '../scenario';
import { CAPABILITIES } from '../seed/auth';
import { seedPolicyVersions, type PolicyVersionRow } from '../seed/policies';
import { currentSession, touchSession, userById } from '../session';

/**
 * Policy engine of docs/api.md in MSW. Policies live in the shared db (rows keep the proposal's ids, so other
 * slices reading db.policies keep working); answers use the backend ids. PUT bumps the version, writes history,
 * audits and emits `policy.updated`, so new uploads read the new policy immediately.
 */
db.register('policyVersions', seedPolicyVersions);

const MiB = 1024 * 1024;
const LEGACY: Record<PolicyCategory, string> = { fault_records: 'fault', drone_videos: 'drone', connection_documents: 'connection', meter_readings: 'meter' };
const LABEL = { s3: 'S3', ftp: 'FTP', db: 'DB' } as const;
const trace = () => `mock-${crypto.randomUUID().slice(0, 8)}`;

function fail(status: number, code: string, message: string, extras: Record<string, unknown> = {}): Response {
  const traceId = trace();
  return HttpResponse.json({ code, message, traceId, ...extras }, { status, headers: { 'X-Trace-Id': traceId } });
}

const matches = (c: PolicyCategory) => (row: { category: string }) => row.category === c || row.category === LEGACY[c];

function read(c: PolicyCategory): PolicyDoc | null {
  const row = db.find<{ category: string }>('policies', matches(c));
  if (!row) return null;
  const p = toPolicy(row);
  return { ...p, maxConcurrency: p.maxConcurrency ?? 8 };
}

function unauthenticated(): Response | null {
  if (!currentSession()) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  touchSession();
  return null;
}

const COMPARED = ['primaryStorage', 'fallbackStorage', 'encryptionAtRest', 'chunkSize', 'maxParallel', 'maxFileSize', 'allowedTypes', 'retentionDays'] as const;
const show = (v: unknown): string | null => (v === null || v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v));

function changes(a: PolicyDoc, b: PolicyDoc): PolicyChange[] {
  return COMPARED.filter((f) => show(a[f]) !== show(b[f])).map((f) => ({ field: f, from: show(a[f]), to: show(b[f]) }));
}

type FieldError = { field: string; code: string; message: string };

function validate(body: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const primary = toStorage(body.primaryStorage);
  const fallback = body.fallbackStorage === null || body.fallbackStorage === undefined ? null : toStorage(body.fallbackStorage);
  const inRange = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (!primary) errors.push({ field: 'primaryStorage', code: 'INVALID', message: 'Storage necunoscut.' });
  if (body.fallbackStorage && !fallback) errors.push({ field: 'fallbackStorage', code: 'INVALID', message: 'Storage necunoscut.' });
  if (primary && fallback === primary) errors.push({ field: 'fallbackStorage', code: 'SAME_AS_PRIMARY', message: 'Rezerva trebuie să fie diferită de storage-ul principal.' });
  if (!inRange(body.chunkSize, MiB, 32 * MiB)) errors.push({ field: 'chunkSize', code: 'OUT_OF_RANGE', message: 'Partea trebuie să aibă între 1 și 32 MiB.' });
  if (!inRange(body.maxParallel, 1, 6)) errors.push({ field: 'maxParallel', code: 'OUT_OF_RANGE', message: 'Paralelismul trebuie să fie între 1 și 6.' });
  if (typeof body.encryptionAtRest !== 'boolean') errors.push({ field: 'encryptionAtRest', code: 'INVALID', message: 'Valoare invalidă.' });
  if (typeof body.baseVersion !== 'number') errors.push({ field: 'baseVersion', code: 'INVALID', message: 'Versiunea de bază lipsește.' });
  return errors;
}

export const policyHandlers = [
  http.get(apiUrl('/policies'), () => {
    const denied = unauthenticated();
    if (denied) return denied;
    return HttpResponse.json({ data: POLICY_CATEGORIES.map(read).filter(Boolean) });
  }),

  http.get(apiUrl('/policies/:category/versions'), ({ params }) => {
    const denied = unauthenticated();
    if (denied) return denied;
    const c = toCategory(params.category);
    if (!c) return fail(404, 'POLICY_NOT_FOUND', 'Categoria nu există.');
    const rows = db.list<PolicyVersionRow>('policyVersions').filter((r) => r.category === c).sort((a, b) => b.version - a.version);
    return HttpResponse.json({ data: rows.map((r) => ({ version: r.version, policy: r.policy, changedAt: r.changedAt, changedBy: r.changedBy, changes: r.changes })) });
  }),

  http.get(apiUrl('/policies/:category'), ({ params }) => {
    const denied = unauthenticated();
    if (denied) return denied;
    const c = toCategory(params.category);
    const p = c && read(c);
    return p ? HttpResponse.json(p) : fail(404, 'POLICY_NOT_FOUND', 'Categoria nu există.');
  }),

  http.put(apiUrl('/policies/:category'), async ({ request, params }) => {
    const session = currentSession();
    if (!session) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
    if (request.headers.get('X-Requested-With') !== 'filegrid') return fail(403, 'CSRF_REJECTED', 'Cererea nu are antetul anti-CSRF.');
    touchSession();
    if (!CAPABILITIES[session.activeRole].includes('edit_policies')) return fail(403, 'FORBIDDEN', 'Doar administratorul poate modifica politicile.');
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    // No await from here on: read, version check and write are one atomic step, like the backend's transaction.
    const c = toCategory(params.category);
    const current = c && read(c);
    if (!c || !current) return fail(404, 'POLICY_NOT_FOUND', 'Categoria nu există.');
    const fieldErrors = validate(body);
    if (fieldErrors.length) return fail(422, 'VALIDATION_ERROR', 'Politica nu este validă.', { fieldErrors });
    if (body.baseVersion !== current.version) {
      return fail(409, 'POLICY_VERSION_CONFLICT', 'Politica a fost modificată între timp de altcineva.', { currentPolicy: current });
    }
    if (current.encryptionLocked && body.encryptionAtRest !== true) {
      return fail(422, 'ENCRYPTION_LOCKED', 'Criptarea nu poate fi dezactivată pentru documentele de racordare.');
    }

    const actor = userById(session.realUserId) ?? null;
    const next: PolicyDoc = {
      ...current,
      version: current.version + 1,
      primaryStorage: toStorage(body.primaryStorage)!,
      fallbackStorage: body.fallbackStorage ? toStorage(body.fallbackStorage) : null,
      encryptionAtRest: body.encryptionAtRest as boolean,
      chunkSize: body.chunkSize as number,
      maxParallel: body.maxParallel as number,
      maxFileSize: typeof body.maxFileSize === 'number' ? body.maxFileSize : current.maxFileSize,
      allowedTypes: Array.isArray(body.allowedTypes) ? (body.allowedTypes as string[]) : current.allowedTypes,
      retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : current.retentionDays,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    // Stored in the db's format (proposal ids) so every reader of db.policies sees the new version.
    db.update<{ category: string }>('policies', matches(c), {
      ...next,
      category: LEGACY[c],
      primaryStorage: LABEL[next.primaryStorage],
      fallbackStorage: next.fallbackStorage ? LABEL[next.fallbackStorage] : null,
    } as never);
    db.insert<PolicyVersionRow>('policyVersions', { category: c, version: next.version, policy: next, changedAt: next.updatedAt, changedBy: actor, changes: changes(current, next) });
    db.audit.append({ actor, actingAs: null, demo: false, action: 'policy_update', outcome: 'success', category: c, policyVersion: next.version, traceId: trace() });
    scenario.emit('policy.updated', { category: c, version: next.version });
    return HttpResponse.json(next);
  }),
];
