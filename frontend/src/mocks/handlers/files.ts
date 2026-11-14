import { createSHA256 } from 'hash-wasm';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { apiUrl } from '@/lib/api/base';
import type { Capability, Role, UserRef } from '@/lib/api/types';
import type { StorageId } from '@/lib/upload/types';
import { db } from '../db';
import { CAPABILITIES } from '../seed/auth';
import {
  mockContent, mockRandom, SEED_CUSTODY, SEED_FILES, SEED_PII, SEED_TRACES,
  type FileCategoryId, type MockCustodyRow, type MockFileRow, type MockSpan, type MockTrace,
} from '../seed/files';
import { currentSession, touchSession, userById } from '../session';
import { fieldErrors } from './uploads-validate';

/**
 * The `files` group (files, custody, reveal, verification, content, traces) as backend/src/files and
 * backend/src/observability implement it (docs/api.md "Files", "Monitoring and traces"): real category and storage
 * ids, 404 for a file the active role may not see, personal data only masked except through an audited reveal.
 * State lives in the shared mock db (`files`, `custody`, `traces`, `audit`), so the uploads mock's new files,
 * reveals and corruptions show up here without imports between slices.
 */

const CATEGORIES = ['meter_readings', 'fault_records', 'connection_documents', 'drone_videos'] as const;
const VIEW: Record<FileCategoryId, Capability> = {
  meter_readings: 'view_meters', fault_records: 'view_fault', connection_documents: 'view_connection', drone_videos: 'view_drone',
};
/** The policy primary a fallback write skipped (seeded policies: fault/drone S3 → FTP, connection DB → S3, meter DB → S3). */
const PRIMARY_OF_FALLBACK: Record<StorageId, StorageId> = { ftp: 's3', s3: 'db', db: 's3' };
/** Files up to 8 MiB are verified completely before the first byte is sent (download.service.ts). */
const VERIFY_BEFORE_SEND = 8 * 1024 * 1024;
const MAX_TRACES = 300;

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Mirrors backend/src/files/file.schemas.ts, so mock mode rejects exactly what the real API rejects. */
const querySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  zone: z.enum(['muntenia', 'banat', 'dobrogea']).optional(),
  origin: z.enum(['manual', 'simulator', 'storm', 'seed']).optional(),
  integrity: z.enum(['verified', 'server_verified', 'unverified', 'corrupt']).optional(),
  excludeGenerated: flag.default(false),
  sort: z.enum(['-createdAt', 'createdAt', '-size', 'size']).default('-createdAt'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const revealSchema = z.object({ reason: z.string().trim().min(10).max(500) });

// ─── seed ───────────────────────────────────────────────────────────────────────────────────────────────────

/** `files` and `custody` are base collections, which db.register does not re-seed: add the missing seed rows by id. */
function seedCollection(name: string, rows: { id: string }[]): void {
  db.register(name, rows);
  const have = new Set(db.list<{ id: string }>(name).map((r) => r.id));
  for (const r of rows) if (!have.has(r.id)) db.insert(name, structuredClone(r));
}
seedCollection('files', SEED_FILES);
seedCollection('custody', SEED_CUSTODY);
db.register('traces', SEED_TRACES);

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const newTraceId = () => crypto.randomUUID().replaceAll('-', '');

function reply(body: unknown, traceId = newTraceId(), headers: Record<string, string> = {}): Response {
  return HttpResponse.json(body as never, { status: 200, headers: { 'X-Trace-Id': traceId, ...headers } });
}

function fail(status: number, code: string, message: string, extras: Record<string, unknown> = {}, traceId = newTraceId()): Response {
  return HttpResponse.json({ code, message, traceId, ...extras }, { status, headers: { 'X-Trace-Id': traceId } });
}

const invalid = (error: z.ZodError) => fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.', { fieldErrors: fieldErrors(error) });
const notFound = () => fail(404, 'NOT_FOUND', 'Fișierul nu există.');
const can = (role: Role, capability: Capability) => CAPABILITIES[role].includes(capability);
const files = () => db.list<MockFileRow>('files');

type Caller = { role: Role; real: UserRef };

/** Offline, 401 and CSRF in the backend's order; real activity slides the idle window. */
function gate(request: Request, mutating = false): Caller | Response {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return HttpResponse.error();
  const session = currentSession();
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sesiunea lipsește sau a expirat.');
  if (mutating && request.headers.get('X-Requested-With') !== 'filegrid') return fail(403, 'CSRF_REJECTED', 'Cererea nu are antetul anti-CSRF.');
  touchSession();
  return { role: session.activeRole, real: userById(session.realUserId)! };
}

/** The row, or the backend's 404 when it does not exist or the active role may not see its category. */
function visible(role: Role, id: string): MockFileRow | Response {
  const row = /^[0-9a-f-]{36}$/.test(id) ? files().find((f) => f.id === id) : undefined;
  return row && can(role, VIEW[row.category]) ? row : notFound();
}

const actingAs = (c: Caller): Role | null => (c.role === c.real.role ? null : c.role);
const usernameOf = (actor: unknown): string | null =>
  typeof actor === 'string' ? actor : actor && typeof actor === 'object' && 'username' in actor ? String(actor.username) : null;

/** How the backend renders a stored actor: the username in every field, no role. */
function actorView(actor: unknown) {
  const username = usernameOf(actor);
  return username ? { id: username, username, displayName: username, role: null } : null;
}

/** Uploader as FileSummary shows it: null for meters and system actors (files.service.ts `uploader`). */
const uploaderView = (actor: unknown) => (/^(meter|system|demo):/.test(usernameOf(actor) ?? 'system:') ? null : actorView(actor));

function summary(f: MockFileRow) {
  return {
    id: f.id, displayName: f.displayName, category: f.category, size: f.size, mimeType: f.mimeType, createdAt: f.createdAt,
    uploadedBy: uploaderView(f.uploadedBy), zone: f.zone ?? null, origin: f.origin, storage: f.storage, usedFallback: f.usedFallback,
    integrity: f.integrity, encryptedAtRest: f.encryptedAtRest, policyVersion: f.policyVersion,
  };
}

function detail(f: MockFileRow) {
  return {
    ...summary(f), clientSha256: f.clientSha256, serverSha256: f.serverSha256, policyName: `${f.category} v${f.policyVersion}`,
    encryptionAlgorithm: f.encryptedAtRest ? 'AES-256-GCM' : null, availableAt: f.createdAt, uploadTraceId: f.uploadTraceId,
    lastVerifiedAt: f.lastVerifiedAt ?? null, metadata: f.metadata,
  };
}

/** `attachment; filename="..."; filename*=UTF-8''...` with unsafe characters replaced (download.service.ts). */
function contentDisposition(name: string): string {
  const unsafe = (ch: string) => ch.charCodeAt(0) < 0x20 || ch === '\u007f' || ch === '"' || ch === '\\' || ch === '/';
  const clean = [...name].map((ch) => (unsafe(ch) ? '_' : ch)).join('').slice(0, 200) || 'fisier';
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

const flipOffset = (f: MockFileRow) => (f.tampered ? Math.floor(f.size / 2) : -1);

/** SHA-256 of what the storage now holds. Rows without bytes (uploads mock) get a stand-in that differs from the original. */
async function storedSha256(f: MockFileRow): Promise<string> {
  const hash = await createSHA256();
  hash.init();
  if (f.mockContent) for (const chunk of mockContent(f.id, f.size, flipOffset(f))) hash.update(chunk);
  else hash.update(`${f.serverSha256}:byte ${flipOffset(f)} flipped`);
  return hash.digest('hex');
}

function recordTrace(trace: MockTrace): void {
  db.insert('traces', trace);
  const all = db.list<MockTrace>('traces');
  if (all.length > MAX_TRACES) {
    const drop = new Set(all.slice(0, all.length - MAX_TRACES).map((t) => t.traceId));
    db.remove<MockTrace>('traces', (t) => drop.has(t.traceId));
  }
}

/** One traced operation on a file; spans run back to back with jitter keyed by the trace id. */
function operationTrace(traceId: string, operation: string, f: MockFileRow, startedAt: number, steps: [name: string, storage: StorageId | null, durationMs: number, errorCode?: string][]): MockTrace {
  const rnd = mockRandom(traceId);
  const round = (n: number) => Math.round(n * 100) / 100;
  let at = 0.2 + rnd() * 0.6;
  const spans: MockSpan[] = steps.map(([name, storage, durationMs, errorCode], i) => {
    const span: MockSpan = { spanId: String(i + 1), parentSpanId: null, name, startOffsetMs: round(at), durationMs: round(durationMs), status: errorCode ? 'error' : 'ok', storage, errorCode: errorCode ?? null };
    at += durationMs + 0.1 + rnd() * 0.4;
    return span;
  });
  const durationMs = round(at + 0.3);
  return {
    traceId, operation, category: f.category, fileId: f.id, storage: f.storage, startedAt: new Date(startedAt).toISOString(), durationMs,
    // A failed step that was recovered (S3 down, written to the fallback) leaves the operation ok; a failed last step does not.
    status: spans.at(-1)?.status ?? 'ok', spans,
  };
}

/** The upload (or meter batch) trace of a file, derived from its row: policy, storage write(s), confirm. */
function uploadTrace(f: MockFileRow): MockTrace {
  const rnd = mockRandom(`${f.uploadTraceId}:steps`);
  const mib = f.size / (1024 * 1024);
  const writeMs = f.category === 'drone_videos' ? mib * (5 + rnd() * 3) : f.category === 'meter_readings' ? 3 + rnd() * 9 : 18 + mib * (8 + rnd() * 10);
  const steps: [string, StorageId | null, number, string?][] = [['policy', null, 0.6 + rnd() * 1.4]];
  if (f.usedFallback) steps.push(['storage.put', PRIMARY_OF_FALLBACK[f.storage], 40 + rnd() * 90, 'StorageUnavailable']);
  steps.push(['storage.put', f.storage, writeMs], ['confirm', null, 2 + rnd() * 8]);
  const trace = operationTrace(f.uploadTraceId, f.category === 'meter_readings' ? 'meter.batch' : 'upload.complete', f, 0, steps);
  return { ...trace, startedAt: new Date(Date.parse(f.createdAt) - trace.durationMs).toISOString() };
}

function audit(c: Caller | null, f: MockFileRow, action: string, outcome: string, traceId: string, extra: Record<string, unknown> = {}) {
  const actor = c ? c.real : { id: 'system:download', username: 'system:download', displayName: 'system:download', role: null };
  return db.audit.append({ actor, actingAs: c ? actingAs(c) : null, demo: c ? actingAs(c) !== null : false, action, outcome, category: f.category, fileId: f.id, traceId, ...extra });
}

function markCorrupt(f: MockFileRow, c: Caller | null, traceId: string): void {
  db.update<MockFileRow>('files', (x) => x.id === f.id, { integrity: 'corrupt', lastVerifiedAt: new Date().toISOString() });
  audit(c, f, 'file_corrupted', 'failure', traceId, { details: `stored hash mismatch on ${f.storage}` });
}

const corruptResponse = (f: MockFileRow, actualSha256: string | null, traceId = newTraceId()) =>
  fail(409, 'FILE_CORRUPT', 'Fișierul stocat este corupt: suma de control nu mai coincide.', { expectedSha256: f.serverSha256, actualSha256, storage: f.storage }, traceId);

const CUSTODY_TYPE: Record<string, string> = {
  upload: 'upload_completed', download: 'downloaded', verify: 'verified', reveal_pii: 'pii_revealed', file_corrupted: 'corruption_detected',
};

type AuditRow = { id: string; at: string; actor: unknown; actingAs?: Role | null; demo?: boolean; action: string; fileId?: string | null; reason?: string | null; details?: string | null; traceId?: string | null };

// ─── handlers ───────────────────────────────────────────────────────────────────────────────────────────────

const listHandler = http.get(apiUrl('/files'), ({ request }) => {
  const c = gate(request);
  if (c instanceof Response) return c;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  const allowed = CATEGORIES.filter((cat) => can(c.role, VIEW[cat]));
  const categories: readonly FileCategoryId[] = q.category ? allowed.filter((cat) => cat === q.category) : allowed;
  const needle = q.q?.toLowerCase();
  const from = q.from ? Date.parse(q.from) : -Infinity;
  const to = q.to ? Date.parse(q.to) : Infinity;
  const rows = files().filter((f) => {
    const at = Date.parse(f.createdAt);
    return categories.includes(f.category) && at >= from && at <= to
      // Search covers the display-safe name only: personal data is masked in metadata and never searchable.
      && (!needle || f.displayName.toLowerCase().includes(needle))
      && (!q.zone || f.zone === q.zone) && (!q.origin || f.origin === q.origin) && (!q.integrity || f.integrity === q.integrity)
      && (!q.excludeGenerated || f.origin === 'manual');
  });
  const bySize = q.sort.endsWith('size');
  const dir = q.sort.startsWith('-') ? -1 : 1;
  const key = (f: MockFileRow) => (bySize ? f.size : Date.parse(f.createdAt));
  rows.sort((a, b) => (key(a) - key(b)) * dir || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = rows.length;
  const data = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(summary);
  return reply({ data, meta: { page: q.page, pageSize: q.pageSize, total, hasMore: q.page * q.pageSize < total } });
});

const detailHandler = http.get(apiUrl('/files/:fileId'), ({ request, params }) => {
  const c = gate(request);
  if (c instanceof Response) return c;
  const f = visible(c.role, String(params.fileId));
  return f instanceof Response ? f : reply(detail(f));
});

const contentHandler = http.get(apiUrl('/files/:fileId/content'), async ({ request, params }) => {
  const c = gate(request);
  if (c instanceof Response) return c;
  const f = visible(c.role, String(params.fileId));
  if (f instanceof Response) return f;
  if (f.integrity === 'corrupt') return corruptResponse(f, null);
  const traceId = newTraceId();
  const started = Date.now();
  if (f.tampered && (f.size <= VERIFY_BEFORE_SEND || !f.mockContent)) {
    const actual = await storedSha256(f);
    markCorrupt(f, null, traceId);
    recordTrace(operationTrace(traceId, 'file.download', f, started, [['storage.get', f.storage, 20 + f.size / 1e5, 'IntegrityError']]));
    return corruptResponse(f, actual, traceId);
  }
  if (!f.mockContent) {
    return fail(501, 'NOT_MOCKED', 'În modul simulat, conținutul fișierelor încărcate nu se păstrează; descărcați un fișier din datele inițiale.', {}, traceId);
  }
  if (!f.tampered) {
    audit(c, f, 'download', 'success', traceId);
    recordTrace(operationTrace(traceId, 'file.download', f, started, [['storage.get', f.storage, 8 + f.size / 2e5]]));
  }
  const chunks = mockContent(f.id, f.size, flipOffset(f));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (!next.done) controller.enqueue(next.value);
      else if (!f.tampered) controller.close();
      else {
        // Large files stream first; a wrong hash at the end cuts the connection instead of ending it cleanly.
        markCorrupt(f, null, traceId);
        controller.error(new Error('FILE_CORRUPT'));
      }
    },
  });
  return new HttpResponse(body, {
    status: 200,
    headers: {
      'Content-Type': f.mimeType, 'Content-Length': String(f.size), 'Content-Disposition': contentDisposition(f.displayName),
      'X-Content-Type-Options': 'nosniff', 'X-File-SHA256': f.serverSha256, ETag: `"${f.serverSha256}"`, 'Accept-Ranges': 'none',
      'Cache-Control': 'private, no-store', 'X-Trace-Id': traceId,
    },
  });
});

const verificationHandler = http.post(apiUrl('/files/:fileId/verification'), async ({ request, params }) => {
  const c = gate(request, true);
  if (c instanceof Response) return c;
  const f = visible(c.role, String(params.fileId));
  if (f instanceof Response) return f;
  const traceId = newTraceId();
  const started = Date.now();
  const corrupt = f.tampered === true;
  const actualSha256 = corrupt ? await storedSha256(f) : f.serverSha256;
  if (corrupt) markCorrupt(f, c, traceId);
  else db.update<MockFileRow>('files', (x) => x.id === f.id, { integrity: f.integrity === 'verified' ? 'verified' : 'server_verified', lastVerifiedAt: new Date().toISOString() });
  audit(c, f, 'verify', corrupt ? 'failure' : 'success', traceId);
  recordTrace(operationTrace(traceId, 'file.verify', f, started, [['hash.verify', f.storage, 15 + f.size / 1.5e5, corrupt ? 'IntegrityError' : undefined]]));
  return reply({ fileId: f.id, state: corrupt ? 'corrupt' : 'server_verified', expectedSha256: f.serverSha256, actualSha256, storage: f.storage, verifiedAt: new Date().toISOString(), traceId }, traceId);
});

const custodyHandler = http.get(apiUrl('/files/:fileId/custody'), ({ request, params }) => {
  const c = gate(request);
  if (c instanceof Response) return c;
  const f = visible(c.role, String(params.fileId));
  if (f instanceof Response) return f;
  const common = { storage: f.storage, policyVersion: f.policyVersion };
  const fromAudit = db.list<AuditRow>('audit').filter((e) => e.fileId === f.id).map((e) => ({
    id: e.id, type: e.details?.startsWith('demo') ? 'demo_corrupted' : (CUSTODY_TYPE[e.action] ?? e.action), at: e.at, actor: actorView(e.actor),
    actingAs: e.actingAs ?? null, demo: e.demo ?? false, ...common, reason: e.reason ?? null, traceId: e.traceId ?? null,
  }));
  const fromSeed = db.list<MockCustodyRow>('custody').filter((e) => e.fileId === f.id).map((e) => ({
    id: e.id, type: e.type, at: e.at, actor: actorView(e.actor), actingAs: e.actingAs ?? null, demo: e.demo ?? false, ...common, reason: e.reason ?? null, traceId: e.traceId ?? null,
  }));
  const stored = { id: `stored-${f.id}`, type: 'stored', at: f.createdAt, actor: uploaderView(f.uploadedBy), actingAs: null, demo: false, ...common, reason: null, traceId: f.uploadTraceId };
  const events = [...fromSeed, ...fromAudit].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return reply({ data: [stored, ...events].slice(0, 201) });
});

const revealHandler = http.post(apiUrl('/files/:fileId/reveal'), async ({ request, params }) => {
  const c = gate(request, true);
  if (c instanceof Response) return c;
  if (!can(c.role, 'reveal_pii')) return fail(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
  const parsed = revealSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);
  const f = visible(c.role, String(params.fileId));
  if (f instanceof Response) return f;
  const pii = SEED_PII[f.id];
  if (!pii) return fail(404, 'NOT_FOUND', 'Fișierul nu are date personale.');
  const traceId = newTraceId();
  const event = audit(c, f, 'reveal_pii', 'success', traceId, { reason: parsed.data.reason });
  return reply(
    { fileId: f.id, applicantName: pii.applicantName, cnp: pii.cnp, address: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), auditEventId: event.id },
    traceId,
    { 'Cache-Control': 'no-store' },
  );
});

const traceHandler = http.get(apiUrl('/traces/:traceId'), ({ request, params }) => {
  const c = gate(request);
  if (c instanceof Response) return c;
  const id = String(params.traceId);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return fail(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.', { fieldErrors: [{ field: '', code: 'invalid_format', message: 'Invalid string' }] });
  const stored = db.find<MockTrace>('traces', (t) => t.traceId === id);
  if (stored) return reply(stored);
  const file = files().find((f) => f.uploadTraceId === id);
  return file ? reply(uploadTrace(file)) : fail(404, 'NOT_FOUND', 'Nu există o urmă cu acest ID.');
});

export const fileHandlers = [listHandler, contentHandler, verificationHandler, custodyHandler, revealHandler, detailHandler, traceHandler];
