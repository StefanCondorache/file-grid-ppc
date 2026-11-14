import { createHash } from 'node:crypto';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { SEED_PASSWORD } from '../seed/auth';
import { mockContent, SEED_FILES, SEED_IDS, SEED_PII } from '../seed/files';
import { buildHandlers } from './index';
import { maskCnp, maskName } from './uploads-validate';

type UserView = { id: string; username: string; displayName: string; role: string | null } | null;
type Summary = {
  id: string; displayName: string; category: string; size: number; mimeType: string; createdAt: string; uploadedBy: UserView;
  zone: string | null; origin: string; storage: string; usedFallback: boolean; integrity: string; encryptedAtRest: boolean; policyVersion: number;
};
type Detail = Summary & {
  clientSha256: string | null; serverSha256: string; policyName: string; encryptionAlgorithm: string | null; availableAt: string | null;
  uploadTraceId: string; lastVerifiedAt: string | null; metadata: Record<string, unknown>;
};
type Page = { data: Summary[]; meta: { page: number; pageSize: number; total: number; hasMore: boolean } };
type ErrorBody = { code: string; message: string; traceId: string | null; expectedSha256?: string; actualSha256?: string | null; storage?: string };
type Custody = { data: { type: string; actor: UserView; actingAs: string | null; demo: boolean; reason: string | null; storage: string | null; traceId: string | null }[] };
type Reveal = { fileId: string; applicantName: string; cnp: string; address: string | null; expiresAt: string; auditEventId: string };
type Verification = { fileId: string; state: string; expectedSha256: string; actualSha256: string; storage: string; verifiedAt: string; traceId: string };
type Trace = {
  traceId: string; operation: string; category: string | null; fileId: string | null; storage: string | null; startedAt: string; durationMs: number;
  status: string; spans: { spanId: string; name: string; startOffsetMs: number; durationMs: number; status: string; storage: string | null; errorCode: string | null }[];
};

const MiB = 1024 * 1024;
const CSRF = { 'Content-Type': 'application/json', 'X-Requested-With': 'filegrid' };
const SUMMARY_KEYS = ['id', 'displayName', 'category', 'size', 'mimeType', 'createdAt', 'uploadedBy', 'zone', 'origin', 'storage', 'usedFallback', 'integrity', 'encryptedAtRest', 'policyVersion'];

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'files', 'demo'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => db.reset());

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(url(path), init);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}
const get = <T,>(path: string) => call<T>(path);
const post = <T,>(path: string, body: unknown, headers: Record<string, string> = CSRF) => call<T>(path, { method: 'POST', headers, body: JSON.stringify(body) });

async function list(query = ''): Promise<Page> {
  const r = await get<Page>(`/files${query}`);
  expect(r.status).toBe(200);
  return r.body;
}

const ms = (iso: string) => Date.parse(iso);
const seedCount = (pred: (f: (typeof SEED_FILES)[number]) => boolean) => SEED_FILES.filter(pred).length;

describe('files mock: list', () => {
  beforeEach(() => login('auditor'));

  it('filters by category, zone and date range', async () => {
    const faults = await list('?category=fault_records&pageSize=200');
    expect(faults.meta.total).toBe(seedCount((f) => f.category === 'fault_records'));
    expect(new Set(faults.data.map((f) => f.category))).toEqual(new Set(['fault_records']));

    const dobrogea = await list('?category=fault_records&zone=dobrogea&pageSize=200');
    expect(dobrogea.meta.total).toBe(seedCount((f) => f.category === 'fault_records' && f.zone === 'dobrogea'));
    expect(dobrogea.data.length).toBeGreaterThan(0);
    expect(dobrogea.data.every((f) => f.zone === 'dobrogea' && f.category === 'fault_records')).toBe(true);

    const from = '2026-11-14T13:30:00Z';
    const to = '2026-11-14T16:30:00+02:00'; // 14:30Z: offsets are honoured
    const storm = await list(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=200`);
    expect(storm.data.length).toBeGreaterThan(0);
    expect(storm.meta.total).toBe(seedCount((f) => ms(f.createdAt) >= ms(from) && ms(f.createdAt) <= ms(to)));
    expect(storm.data.every((f) => ms(f.createdAt) >= ms(from) && ms(f.createdAt) <= ms(to))).toBe(true);

    const invalid = await get<ErrorBody>('/files?zone=moldova');
    expect([invalid.status, invalid.body.code]).toEqual([422, 'VALIDATION_ERROR']);
  });

  it('searches display names (request number included) but never the applicant name or CNP', async () => {
    const pii = SEED_PII[SEED_IDS.connectionRequest]!;
    for (const q of [pii.applicantName, pii.applicantName.split(' ').at(-1)!, pii.cnp]) {
      expect([q, (await list(`?q=${encodeURIComponent(q)}`)).meta.total]).toEqual([q, 0]);
    }
    const request = SEED_FILES.find((f) => f.id === SEED_IDS.connectionRequest)!.metadata.requestNumber as string;
    const byRequest = await list(`?q=${encodeURIComponent(request.toLowerCase())}&pageSize=200`);
    expect(byRequest.data.map((f) => f.id).sort()).toEqual(
      SEED_FILES.filter((f) => f.displayName.includes(request)).map((f) => f.id).sort(),
    );
    expect(byRequest.data.length).toBeGreaterThan(0);
  });

  it('excludeGenerated keeps only manual uploads', async () => {
    const all = await list('?pageSize=200');
    expect(new Set(all.data.map((f) => f.origin))).toEqual(new Set(['manual', 'seed', 'simulator', 'storm']));
    const manual = await list('?excludeGenerated=true&pageSize=200');
    expect(manual.meta.total).toBe(seedCount((f) => f.origin === 'manual'));
    expect(manual.data.every((f) => f.origin === 'manual')).toBe(true);
    const storm = await list('?origin=storm&pageSize=200');
    expect(storm.data.length).toBeGreaterThan(0);
    expect(storm.data.every((f) => f.origin === 'storm')).toBe(true);
  });

  it('sorts newest first by default and pages with meta.total and meta.hasMore', async () => {
    const total = SEED_FILES.length;
    const first = await list('?pageSize=10');
    expect(first.meta).toEqual({ page: 1, pageSize: 10, total, hasMore: true });
    const times = first.data.map((f) => ms(f.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times[0]).toBe(Math.max(...SEED_FILES.map((f) => ms(f.createdAt))));

    const lastPage = Math.ceil(total / 10);
    const pages = await Promise.all(Array.from({ length: lastPage }, (_, i) => list(`?pageSize=10&page=${i + 1}`)));
    expect(pages.at(-1)!.meta.hasMore).toBe(false);
    expect(pages.at(-1)!.data).toHaveLength(total - 10 * (lastPage - 1));
    expect(new Set(pages.flatMap((p) => p.data.map((f) => f.id))).size).toBe(total);

    const sizes = (await list('?sort=size&pageSize=200')).data.map((f) => f.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect((await list()).meta.pageSize).toBe(50);
  });

  it('lists only the categories the active role may see', async () => {
    await login('teren');
    expect(new Set((await list('?pageSize=200')).data.map((f) => f.category))).toEqual(new Set(['fault_records', 'drone_videos']));
    expect((await list('?category=connection_documents')).meta).toMatchObject({ total: 0, hasMore: false });
    await login('racordari');
    expect(new Set((await list('?pageSize=200')).data.map((f) => f.category))).toEqual(new Set(['connection_documents']));
  });

  it('lists rows written by the uploads mock in the FileSummary shape, uploader as the backend shows it', async () => {
    const id = crypto.randomUUID();
    db.files.insert({
      id, displayName: 'Avarie_nouă.pdf', category: 'fault_records', size: 1024, mimeType: 'application/pdf', createdAt: new Date().toISOString(),
      uploadedBy: { id: 'u-teren', username: 'teren', displayName: 'Ion Pop', role: 'teren' }, zone: 'banat', origin: 'manual', storage: 's3',
      usedFallback: false, integrity: 'verified', encryptedAtRest: false, policyVersion: 3, clientSha256: 'a'.repeat(64), serverSha256: 'a'.repeat(64),
      metadata: { kind: 'fault', zone: 'banat', substation: 'PT Lugoj 2', eventTime: '2026-11-14T10:00:00+02:00', severity: 'low' },
      availableAt: new Date().toISOString(), uploadTraceId: 'mock-1234abcd',
    });
    const top = (await list('?pageSize=1')).data[0]!;
    expect(top).toMatchObject({ id, displayName: 'Avarie_nouă.pdf', uploadedBy: { id: 'teren', username: 'teren', displayName: 'teren', role: null } });
    expect(Object.keys(top).sort()).toEqual([...SUMMARY_KEYS].sort());
    expect((await get<Trace>('/traces/mock-1234abcd')).body).toMatchObject({ operation: 'upload.complete', fileId: id, storage: 's3', status: 'ok' });
    // The uploads mock hashes parts and drops them, so it has no bytes to serve.
    expect((await get<ErrorBody>(`/files/${id}/content`)).body.code).toBe('NOT_MOCKED');
  });
});

describe('files mock: personal data', () => {
  const id = SEED_IDS.connectionRequest;
  const reason = 'Verificare dosar la cererea responsabilului GDPR';

  it('racordari sees connection documents with masked personal data only', async () => {
    await login('racordari');
    const docs = await list('?pageSize=200');
    expect(docs.meta.total).toBe(seedCount((f) => f.category === 'connection_documents'));
    for (const doc of docs.data) {
      const { status, body } = await get<Detail>(`/files/${doc.id}`);
      const pii = SEED_PII[doc.id]!;
      expect(status).toBe(200);
      expect(body).toMatchObject({ encryptedAtRest: true, encryptionAlgorithm: 'AES-256-GCM', storage: 'db' });
      expect(body.metadata).toMatchObject({ kind: 'connection', applicantNameMasked: maskName(pii.applicantName), cnpMasked: maskCnp(pii.cnp) });
      expect(body.metadata).not.toHaveProperty('applicantName');
      expect(body.metadata).not.toHaveProperty('cnp');
      const text = JSON.stringify(body) + JSON.stringify(docs);
      for (const secret of [pii.cnp, ...pii.applicantName.split(' ')]) expect(text).not.toContain(secret);
    }
  });

  it('teren gets 404 for a connection document', async () => {
    await login('teren');
    for (const suffix of ['', '/custody', '/content']) {
      const r = await get<ErrorBody>(`/files/${id}${suffix}`);
      expect([suffix, r.status, r.body.code]).toEqual([suffix, 404, 'NOT_FOUND']);
    }
  });

  it('reveal: racordari gets 403, the auditor gets the values for 60 s and the reveal is audited', async () => {
    const pii = SEED_PII[id]!;
    await login('racordari');
    const denied = await post<ErrorBody>(`/files/${id}/reveal`, { reason });
    expect([denied.status, denied.body.code]).toEqual([403, 'FORBIDDEN']);

    await login('auditor');
    expect((await post<ErrorBody>(`/files/${id}/reveal`, { reason: 'scurt' })).body.code).toBe('VALIDATION_ERROR');
    expect((await post<ErrorBody>(`/files/${id}/reveal`, { reason }, { 'Content-Type': 'application/json' })).body.code).toBe('CSRF_REJECTED');
    const before = Date.now();
    const ok = await post<Reveal>(`/files/${id}/reveal`, { reason });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ fileId: id, applicantName: pii.applicantName, cnp: pii.cnp, address: null });
    expect(ms(ok.body.expiresAt) - before).toBeGreaterThanOrEqual(59_000);
    expect(ms(ok.body.expiresAt) - before).toBeLessThanOrEqual(61_000);

    const audited = db.list<{ id: string; action: string; fileId: string; reason: string; outcome: string }>('audit').filter((e) => e.action === 'reveal_pii');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ id: ok.body.auditEventId, fileId: id, reason, outcome: 'success' });
    const custody = (await get<Custody>(`/files/${id}/custody`)).body.data;
    expect(custody.find((e) => e.type === 'pii_revealed' && e.reason === reason)).toMatchObject({ actor: { username: 'auditor' }, actingAs: null, demo: false });
  });

  it('a reveal by the admin acting as auditor is recorded with the demo role', async () => {
    await login('admin');
    expect((await post<ErrorBody>(`/files/${id}/reveal`, { reason })).status).toBe(403);
    await unwrap(api.POST('/demo/acting-role', { body: { role: 'auditor' } }));
    expect((await post<Reveal>(`/files/${id}/reveal`, { reason })).status).toBe(200);
    const custody = (await get<Custody>(`/files/${id}/custody`)).body.data;
    expect(custody.find((e) => e.type === 'pii_revealed' && e.reason === reason)).toMatchObject({ actor: { username: 'admin' }, actingAs: 'auditor', demo: true });
  });
});

describe('files mock: download, verification, custody and traces', () => {
  beforeEach(() => login('auditor'));

  it('serves the stored bytes with their SHA-256', async () => {
    const id = SEED_IDS.stormFault;
    const detail = (await get<Detail>(`/files/${id}`)).body;
    expect(detail.clientSha256).toBe(detail.serverSha256);
    const res = await fetch(url(`/files/${id}/content`));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-SHA256')).toBe(detail.serverSha256);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; /);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(detail.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(detail.serverSha256);
    expect((await get<Custody>(`/files/${id}/custody`)).body.data.map((e) => e.type)).toContain('downloaded');
  });

  it('answers 409 FILE_CORRUPT with the expected hash and the storage for the corrupt file', async () => {
    const detail = (await get<Detail>(`/files/${SEED_IDS.corruptFault}`)).body;
    expect(detail.integrity).toBe('corrupt');
    const r = await get<ErrorBody>(`/files/${SEED_IDS.corruptFault}/content`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'FILE_CORRUPT', expectedSha256: detail.serverSha256, storage: detail.storage });
    expect(r.body.traceId).toBeTruthy();
  });

  it('verification confirms a clean file and detects a demo corruption', async () => {
    const id = SEED_IDS.stormFault;
    const clean = await post<Verification>(`/files/${id}/verification`, {});
    expect(clean.status).toBe(200);
    expect(clean.body).toMatchObject({ fileId: id, state: 'server_verified', storage: 's3' });
    expect(clean.body.actualSha256).toBe(clean.body.expectedSha256);
    expect((await get<Detail>(`/files/${id}`)).body.integrity).toBe('verified');

    db.update<{ id: string; tampered?: boolean }>('files', (f) => f.id === id, { tampered: true });
    const bad = await post<Verification>(`/files/${id}/verification`, {});
    expect(bad.body.state).toBe('corrupt');
    expect(bad.body.actualSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bad.body.actualSha256).not.toBe(bad.body.expectedSha256);
    expect((await get<Detail>(`/files/${id}`)).body.integrity).toBe('corrupt');
    expect((await get<ErrorBody>(`/files/${id}/content`)).status).toBe(409);
    const types = (await get<Custody>(`/files/${id}/custody`)).body.data.map((e) => e.type);
    expect(types[0]).toBe('stored');
    expect(types).toEqual(expect.arrayContaining(['upload_completed', 'verified', 'corruption_detected']));
    expect((await get<Trace>(`/traces/${bad.body.traceId}`)).body).toMatchObject({ operation: 'file.verify', fileId: id, status: 'error' });
  });

  it('resolves the upload trace of the fallback file with the failed S3 step', async () => {
    const detail = (await get<Detail>(`/files/${SEED_IDS.fallbackFault}`)).body;
    expect(detail).toMatchObject({ storage: 'ftp', usedFallback: true, policyName: 'fault_records v3' });
    const trace = await get<Trace>(`/traces/${detail.uploadTraceId}`);
    expect(trace.status).toBe(200);
    expect(trace.body).toMatchObject({ traceId: detail.uploadTraceId, operation: 'upload.complete', category: 'fault_records', fileId: detail.id, storage: 'ftp', status: 'ok' });
    expect(trace.body.spans.map((s) => [s.name, s.storage, s.status])).toEqual([
      ['policy', null, 'ok'], ['storage.put', 's3', 'error'], ['storage.put', 'ftp', 'ok'], ['confirm', null, 'ok'],
    ]);
    expect(trace.body.spans.every((s) => s.startOffsetMs + s.durationMs <= trace.body.durationMs)).toBe(true);
    expect(JSON.stringify(trace.body)).not.toMatch(/s3:\/\/|ftp:\/\/|https?:\/\//);
    expect((await get<ErrorBody>('/traces/necunoscut-123')).status).toBe(404);
  });
});

describe('files seed', () => {
  it('covers the demo: 4 categories, 3 zones, every origin, one corrupt file, one on the FTP fallback', () => {
    expect(SEED_FILES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SEED_FILES.map((f) => f.category))).toEqual(new Set(['meter_readings', 'fault_records', 'connection_documents', 'drone_videos']));
    expect(new Set(SEED_FILES.map((f) => f.zone).filter(Boolean))).toEqual(new Set(['muntenia', 'banat', 'dobrogea']));
    expect(new Set(SEED_FILES.map((f) => f.origin))).toEqual(new Set(['manual', 'seed', 'simulator', 'storm']));
    expect(SEED_FILES.filter((f) => f.integrity === 'corrupt').map((f) => f.id)).toEqual([SEED_IDS.corruptFault]);
    expect(SEED_FILES.filter((f) => f.usedFallback).map((f) => [f.id, f.storage])).toEqual([[SEED_IDS.fallbackFault, 'ftp']]);
    for (const doc of SEED_FILES.filter((f) => f.category === 'connection_documents')) {
      expect(SEED_PII[doc.id]).toBeDefined();
      expect(Object.keys(doc.metadata)).not.toContain('cnp');
      expect(doc.metadata.cnpMasked).toBe(maskCnp(SEED_PII[doc.id]!.cnp));
    }
  });

  it('every seeded file up to 64 MiB hashes to its stored SHA-256', () => {
    const small = SEED_FILES.filter((f) => f.size <= 64 * MiB);
    expect(small.length).toBeGreaterThan(30);
    for (const f of small) {
      const hash = createHash('sha256');
      for (const chunk of mockContent(f.id, f.size)) hash.update(chunk);
      expect([f.id, hash.digest('hex')]).toEqual([f.id, f.serverSha256]);
    }
  });
});
