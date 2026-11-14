import { delay, http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Policy } from '@/lib/api/types';
import { partsToRanges, type CompleteResult, type PolicyView, type SessionStatus, type UploadSession, type UploadStatus } from '@/lib/upload/contract';
import type { Role, StorageId, UploadCategoryId } from '@/lib/upload/types';
import { db } from '../db';
import { CAPABILITIES } from '../seed/auth';
import { currentSession, endSession, touchSession, userById } from '../session';
import { completeSchema, createUploadSchema, fieldErrors, IDEMPOTENCY_KEY, maskCnp, maskName, type MockCreate } from './uploads-validate';

/**
 * The resumable-upload protocol of the real backend (docs/api.md, backend/src/uploads), in MSW. State lives in the
 * shared mock db (`uploads` collection, persisted in localStorage) so a reload keeps the "server" state. Part
 * bodies are hashed and dropped, never stored. Rehearsal knobs in localStorage['fg.mock'] (mocks only):
 * failRate, offline, expire401Once, corruptPart, completeMismatch, slowComplete (ms), bps (0 = unlimited), rttMs.
 */
export type Flags = { failRate?: number; offline?: boolean; expire401Once?: boolean; corruptPart?: number; completeMismatch?: boolean; slowComplete?: number; bps?: number; rttMs?: number };

type MockUpload = {
  id: string; key: string; owner: string; startedAsRole: Role; category: UploadCategoryId;
  fileName: string; fileSize: number; mimeType: string; chunkSize: number; partCount: number; maxParallel: number;
  policyVersion: number; maxFileSize: number; primary: StorageId; fallback: StorageId | null; encrypted: boolean;
  displayName: string; metadata: Record<string, unknown>; zone: string | null; status: SessionStatus;
  parts: Record<string, { sha256: string; size: number }>; expiresAt: number; createdAt: number;
  clientSha256: string | null; readyAt: number | null; result: CompleteResult | null; error: { code: string; message: string } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BPS = 2 * 1024 * 1024;
const LEGACY: Record<string, string> = { fault_records: 'fault', connection_documents: 'connection', drone_videos: 'drone', meter_readings: 'meter' };
const UPLOAD_CAP: Record<UploadCategoryId, string> = { fault_records: 'upload_fault', connection_documents: 'upload_connection', drone_videos: 'upload_drone' };
const LABEL: Record<StorageId, 'S3' | 'FTP' | 'DB'> = { s3: 'S3', ftp: 'FTP', db: 'DB' };

function flags(): Flags {
  try {
    return JSON.parse(globalThis.localStorage?.getItem('fg.mock') ?? '{}') as Flags;
  } catch {
    return {};
  }
}

function clearFlag(name: keyof Flags): void {
  const next: Flags = { ...flags() };
  delete next[name];
  globalThis.localStorage?.setItem('fg.mock', JSON.stringify(next));
}

/** Tests and rehearsals: replace the upload knobs (keeps the other `fg.mock` settings). */
export function setUploadMockFlags(f: Flags): void {
  const { sessionTtlMs, idleTtlMs, demoMode } = flags() as Flags & Record<string, unknown>;
  globalThis.localStorage?.setItem('fg.mock', JSON.stringify({ sessionTtlMs, idleTtlMs, demoMode, ...f }));
}

const offline = () => (typeof navigator !== 'undefined' && navigator.onLine === false) || flags().offline === true;
const trace = () => `mock-${crypto.randomUUID().slice(0, 8)}`;

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return HttpResponse.json(body as never, { status, headers: { 'X-Trace-Id': trace(), ...headers } });
}

function fail(status: number, code: string, message: string, extras: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  const traceId = trace();
  return HttpResponse.json({ code, message, traceId, ...extras }, { status, headers: { 'X-Trace-Id': traceId, ...headers } });
}

const storageId = (v: unknown): StorageId => String(v).toLowerCase() as StorageId;
const storageUp = (s: StorageId | null): boolean => s !== null && db.storage.status(LABEL[s]) !== 'down';

/** The policy in the real format, read live from the shared db (seeded with the proposal's ids). */
export function policyView(category: string): PolicyView | null {
  const p = db.find<Policy>('policies', (x) => (x.category as string) === category || (x.category as string) === LEGACY[category]);
  if (!p) return null;
  return {
    ...p,
    category: category as PolicyView['category'],
    primaryStorage: storageId(p.primaryStorage),
    fallbackStorage: p.fallbackStorage ? storageId(p.fallbackStorage) : null,
    encryptionAlgorithm: p.encryptionAlgorithm ?? null,
    maxConcurrency: (p as Policy & { maxConcurrency?: number }).maxConcurrency ?? 8,
  };
}

const find = (id: string) => db.find<MockUpload>('uploads', (u) => u.id === id);
const save = (id: string, patch: Partial<MockUpload>) => db.update<MockUpload>('uploads', (u) => u.id === id, patch);
const received = (u: MockUpload) => Object.keys(u.parts).map(Number);
const expectedSize = (u: MockUpload, n: number) => (n < u.partCount ? u.chunkSize : u.fileSize - u.chunkSize * (u.partCount - 1));

function sessionView(u: MockUpload): UploadSession {
  return {
    uploadId: u.id, status: u.status, chunkSize: u.chunkSize, partCount: u.partCount, maxParallel: u.maxParallel, policyVersion: u.policyVersion,
    maxFileSize: u.maxFileSize, expiresAt: new Date(u.expiresAt).toISOString(), displayName: u.displayName, receivedRanges: partsToRanges(received(u)),
  };
}

function statusView(u: MockUpload): UploadStatus {
  return {
    uploadId: u.id, status: u.status, category: u.category, fileSize: u.fileSize, chunkSize: u.chunkSize, partCount: u.partCount,
    receivedRanges: partsToRanges(received(u)), receivedBytes: Object.values(u.parts).reduce((s, p) => s + p.size, 0),
    policyVersion: u.policyVersion, expiresAt: new Date(u.expiresAt).toISOString(), startedAsRole: u.startedAsRole, result: u.result, error: u.error,
  };
}

type Gate = { session: NonNullable<ReturnType<typeof currentSession>> } | { response: Response };

/** Offline, 401 (and the expire-once knob) and CSRF, in the backend's order. */
function gate(request: Request, mutating: boolean): Gate {
  if (offline()) return { response: HttpResponse.error() };
  if (flags().expire401Once) {
    clearFlag('expire401Once');
    endSession();
    return { response: fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.') };
  }
  const session = currentSession();
  if (!session) return { response: fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.') };
  if (mutating && request.headers.get('X-Requested-With') !== 'filegrid') return { response: fail(403, 'CSRF_REJECTED', 'Cererea nu are antetul anti-CSRF.') };
  touchSession();
  return { session };
}

/** Owned and not expired, or the backend's 404 (another user's upload is invisible). */
function owned(id: string, realUserId: string): MockUpload | Response {
  const u = find(id);
  if (!u || u.owner !== realUserId) return fail(404, 'UPLOAD_NOT_FOUND', 'Încărcarea nu există sau nu vă aparține.');
  if (u.status === 'open' && u.expiresAt < Date.now()) return save(id, { status: 'expired' })!;
  if (u.status === 'verifying' && u.readyAt !== null && u.readyAt <= Date.now()) {
    finalize(u);
    return find(id)!;
  }
  return u;
}

function requireOpen(u: MockUpload): Response | null {
  if (u.status === 'open') return null;
  if (u.status === 'completed') return fail(409, 'UPLOAD_COMPLETED', 'Încărcarea este deja finalizată.');
  return fail(409, 'UPLOAD_NOT_OPEN', 'Încărcarea nu mai acceptă părți.', { status: u.status });
}

/** complete's read-back, simulated: the mock never saw the bytes, so the server hash is the client's (or not, on purpose). */
function finalize(u: MockUpload): CompleteResult | Response {
  const storage = storageUp(u.primary) ? u.primary : storageUp(u.fallback) ? u.fallback : null;
  if (!storage) {
    save(u.id, { status: 'open', readyAt: null, error: { code: 'STORAGE_UNAVAILABLE', message: 'Finalizarea nu a reușit; reîncercați.' } });
    return fail(503, 'STORAGE_UNAVAILABLE', `Storage-ul ${u.primary.toUpperCase()} este indisponibil momentan. Celelalte categorii funcționează; reîncercați.`, { storage: u.primary, retryAfterMs: 5000 }, { 'Retry-After': '5' });
  }
  const client = u.clientSha256 ?? '';
  const mismatch = flags().completeMismatch === true;
  const base = { clientSha256: client, size: u.fileSize, storage, usedFallback: storage !== u.primary, policyVersion: u.policyVersion, encryptedAtRest: u.encrypted, traceId: trace() };
  if (mismatch) {
    const result: CompleteResult = { ...base, serverSha256: `${client.slice(0, 63)}${client.endsWith('0') ? '1' : '0'}`, status: 'failed', verdict: 'mismatch', fileId: null };
    save(u.id, { status: 'failed', readyAt: null, result, error: { code: 'FILE_CHECKSUM_MISMATCH', message: 'Suma de control a fișierului nu coincide.' } });
    return result;
  }
  const fileId = crypto.randomUUID();
  const availableAt = new Date().toISOString();
  const result: CompleteResult = { ...base, serverSha256: client, status: 'completed', verdict: 'match', fileId, availableAt, availableAfterMs: Math.round(300 + Math.random() * 900) };
  save(u.id, { status: 'completed', readyAt: null, result, error: null });
  db.files.insert({
    id: fileId, displayName: u.displayName, category: u.category, size: u.fileSize, mimeType: u.mimeType, createdAt: availableAt,
    uploadedBy: userById(u.owner) ?? null, zone: u.zone, origin: 'manual', storage, usedFallback: result.usedFallback, integrity: 'verified',
    encryptedAtRest: u.encrypted, policyVersion: u.policyVersion, clientSha256: client, serverSha256: client, metadata: u.metadata,
    availableAt, uploadTraceId: result.traceId,
  });
  db.audit.append({ actor: userById(u.owner), actingAs: null, demo: false, action: 'upload', outcome: 'success', category: u.category, fileId, traceId: result.traceId });
  return result;
}

function splitMetadata(body: MockCreate) {
  const m = body.metadata;
  if (m.kind === 'connection') {
    const { applicantName, cnp, ...rest } = m;
    return { metadata: { ...rest, applicantNameMasked: maskName(applicantName), cnpMasked: maskCnp(cnp) }, displayName: `Document racordare ${m.requestNumber} (${m.documentType})`, zone: m.zone ?? null };
  }
  return { metadata: m, displayName: body.fileName, zone: m.zone };
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Network shaping: rtt plus bytes / bps (0 = unlimited). */
async function shape(bytes: number): Promise<void> {
  const f = flags();
  const rtt = f.rttMs ?? 60 + Math.random() * 140;
  const bps = f.bps ?? DEFAULT_BPS;
  await delay(Math.round(rtt + (bps > 0 ? (bytes / bps) * 1000 : 0)));
}

export function resetUploadMocks(): void {
  db.remove('uploads', () => true);
}

const createHandler = http.post(apiUrl('/uploads'), async ({ request }) => {
  const g = gate(request, true);
  if ('response' in g) return g.response;
  const parsed = createUploadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(422, 'VALIDATION_ERROR', 'Unele câmpuri nu sunt completate corect.', { fieldErrors: fieldErrors(parsed.error) });
  const key = request.headers.get('Idempotency-Key') ?? '';
  if (!IDEMPOTENCY_KEY.test(key)) return fail(422, 'VALIDATION_ERROR', 'Idempotency-Key: 8-64 caractere (UUID recomandat)');
  const body = parsed.data;
  if (!CAPABILITIES[g.session.activeRole].includes(UPLOAD_CAP[body.category] as never)) return fail(403, 'FORBIDDEN', 'Rolul activ nu poate încărca în această categorie.');
  const kind = { fault_records: 'fault', connection_documents: 'connection', drone_videos: 'drone' }[body.category];
  if (body.metadata.kind !== kind) {
    return fail(422, 'VALIDATION_ERROR', 'Metadatele nu corespund categoriei.', { fieldErrors: [{ field: 'metadata.kind', code: 'invalid_value', message: 'Tip greșit.' }] });
  }
  const existing = db.find<MockUpload>('uploads', (u) => u.owner === g.session.realUserId && u.key === key);
  if (existing) {
    const same = existing.category === body.category && existing.fileSize === body.fileSize && existing.fileName === body.fileName;
    return same ? reply(sessionView(existing), 200) : fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Cheia de idempotență a fost folosită pentru alt fișier.');
  }
  const policy = policyView(body.category);
  if (!policy) return fail(503, 'POLICY_UNAVAILABLE', 'Politica nu este disponibilă.', {}, { 'Retry-After': '2' });
  if (body.fileSize > policy.maxFileSize) return fail(413, 'FILE_TOO_LARGE', 'Fișierul depășește dimensiunea maximă a politicii.', { maxFileSize: policy.maxFileSize });
  if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(body.mimeType)) {
    return fail(422, 'TYPE_NOT_ALLOWED', 'Tipul fișierului nu este permis pentru categorie.', { allowedTypes: policy.allowedTypes });
  }
  const split = splitMetadata(body);
  const u = db.insert<MockUpload>('uploads', {
    id: crypto.randomUUID(), key, owner: g.session.realUserId, startedAsRole: g.session.activeRole, category: body.category,
    fileName: body.fileName, fileSize: body.fileSize, mimeType: body.mimeType, chunkSize: policy.chunkSize, partCount: Math.ceil(body.fileSize / policy.chunkSize),
    maxParallel: policy.maxParallel, policyVersion: policy.version, maxFileSize: policy.maxFileSize, primary: policy.primaryStorage, fallback: policy.fallbackStorage,
    encrypted: policy.encryptionAtRest, displayName: split.displayName, metadata: split.metadata, zone: split.zone, status: 'open', parts: {},
    expiresAt: Date.now() + DAY_MS, createdAt: Date.now(), clientSha256: null, readyAt: null, result: null, error: null,
  });
  return reply(sessionView(u), 201);
});

const partHandler = http.put(apiUrl('/uploads/:id/parts/:n'), async ({ request, params }) => {
  const g = gate(request, true);
  if ('response' in g) return g.response;
  const u = owned(String(params.id), g.session.realUserId);
  if (u instanceof Response) return u;
  const closed = requireOpen(u);
  if (closed) return closed;
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1 || n > u.partCount) return fail(422, 'PART_NUMBER_OUT_OF_RANGE', 'Numărul părții este în afara intervalului.', { partCount: u.partCount });
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/octet-stream')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Părțile se trimit ca application/octet-stream.');
  const declared = request.headers.get('X-Part-SHA256') ?? undefined;
  if (declared !== undefined && !/^[0-9a-f]{64}$/.test(declared)) return fail(422, 'VALIDATION_ERROR', 'X-Part-SHA256 trebuie să fie hex, litere mici.');
  const roll = Math.random();
  const failRate = flags().failRate ?? 0;
  if (roll < failRate / 2) return HttpResponse.error();
  if (roll < failRate) return fail(503, 'CATEGORY_BUSY', 'Prea multe operații simultane pentru această categorie. Reîncercați în câteva secunde.', { retryAfterMs: 2000 }, { 'Retry-After': '2' });
  const previous = u.parts[n];
  if (previous && declared === previous.sha256) return reply({ partNumber: n, size: previous.size, sha256: previous.sha256, alreadyReceived: true });
  const body = await request.arrayBuffer();
  const expected = expectedSize(u, n);
  if (body.byteLength !== expected) return fail(422, 'PART_SIZE_MISMATCH', 'Dimensiunea părții nu este cea așteptată.', { expectedSize: expected, actualSize: body.byteLength });
  if (!storageUp(u.primary) && !storageUp(u.fallback)) {
    return fail(503, 'STORAGE_UNAVAILABLE', `Storage-ul ${u.primary.toUpperCase()} este indisponibil momentan. Celelalte categorii funcționează; reîncercați.`, { storage: u.primary, retryAfterMs: 5000 }, { 'Retry-After': '5' });
  }
  const actual = await sha256Hex(body);
  const corrupt = flags().corruptPart === n;
  if (corrupt) clearFlag('corruptPart');
  if (corrupt || (declared !== undefined && declared !== actual)) {
    return fail(422, 'PART_CHECKSUM_MISMATCH', 'Suma de control a părții nu coincide.', { expectedSha256: declared, actualSha256: corrupt ? '0'.repeat(64) : actual });
  }
  await shape(body.byteLength);
  if (offline()) return HttpResponse.error();
  const now = find(u.id);
  if (!now || now.status !== 'open') return requireOpen(now ?? { ...u, status: 'aborted' }) ?? fail(409, 'UPLOAD_NOT_OPEN', 'Încărcarea nu mai acceptă părți.');
  save(u.id, { parts: { ...now.parts, [n]: { sha256: actual, size: body.byteLength } }, expiresAt: Date.now() + DAY_MS });
  return reply({ partNumber: n, size: body.byteLength, sha256: actual, alreadyReceived: false });
});

const statusHandler = http.get(apiUrl('/uploads/:id'), ({ request, params }) => {
  const g = gate(request, false);
  if ('response' in g) return g.response;
  const u = owned(String(params.id), g.session.realUserId);
  return u instanceof Response ? u : reply(statusView(u));
});

const completeHandler = http.post(apiUrl('/uploads/:id/complete'), async ({ request, params }) => {
  const g = gate(request, true);
  if ('response' in g) return g.response;
  const parsed = completeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(422, 'VALIDATION_ERROR', 'Unele câmpuri nu sunt completate corect.', { fieldErrors: fieldErrors(parsed.error) });
  const u = owned(String(params.id), g.session.realUserId);
  if (u instanceof Response) return u;
  if (u.status === 'completed' && u.result) return reply(u.result);
  if (u.status !== 'open' && u.status !== 'verifying') return requireOpen(u)!;
  if (parsed.data.partCount !== u.partCount) return fail(422, 'PART_COUNT_MISMATCH', 'Numărul de părți nu corespunde încărcării.', { partCount: u.partCount });
  const have = new Set(received(u));
  const missing = Array.from({ length: u.partCount }, (_, i) => i + 1).filter((p) => !have.has(p));
  if (missing.length > 0) return fail(409, 'PARTS_MISSING', 'Lipsesc părți din încărcare.', { missingRanges: partsToRanges(missing) });
  if (u.status === 'verifying') return reply({ status: 'verifying' }, 202, { 'Retry-After': '2' });
  const slow = flags().slowComplete ?? 0;
  save(u.id, { status: 'verifying', clientSha256: parsed.data.sha256, error: null, readyAt: slow > 0 ? Date.now() + slow : null });
  if (slow > 0) return reply({ status: 'verifying' }, 202, { 'Retry-After': '2' });
  const result = finalize(find(u.id)!);
  return result instanceof Response ? result : reply(result);
});

const cancelHandler = http.delete(apiUrl('/uploads/:id'), ({ request, params }) => {
  const g = gate(request, true);
  if ('response' in g) return g.response;
  const u = owned(String(params.id), g.session.realUserId);
  if (u instanceof Response) return u;
  if (u.status === 'completed') return fail(409, 'UPLOAD_COMPLETED', 'Încărcarea este deja finalizată.');
  save(u.id, { status: 'aborted', parts: {} });
  return new HttpResponse(null, { status: 204, headers: { 'X-Trace-Id': trace() } });
});

const ping = () => (offline() ? HttpResponse.error() : new HttpResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));

/**
 * Read-only policy views in the real format, so upload pre-validation works on mocks before slice 6d lands.
 * They sit in the uploads group: 6d's `policies` handlers come first in buildHandlers and win once they exist.
 */
export const policyReadHandlers = [
  http.get(apiUrl('/policies'), () => reply({ data: ['meter_readings', 'fault_records', 'connection_documents', 'drone_videos'].map(policyView).filter(Boolean) })),
  http.get(apiUrl('/policies/:category'), ({ params }) => {
    const p = policyView(String(params.category));
    return p ? reply(p) : fail(404, 'NOT_FOUND', 'Categoria nu există.');
  }),
];

export const uploadHandlers = [
  createHandler,
  partHandler,
  completeHandler,
  statusHandler,
  cancelHandler,
  http.head(apiUrl('/ping'), ping),
  http.get(apiUrl('/ping'), ping),
  ...policyReadHandlers,
];
