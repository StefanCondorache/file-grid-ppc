import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import type { Policy } from '@/lib/api/types';
import { db } from '../db';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';
import { resetUploadMocks } from './uploads';

const MiB = 1024 * 1024;
const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'uploads', 'policies'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  resetUploadMocks();
  localStorage.setItem('fg.mock', JSON.stringify({ rttMs: 0, bps: 0 }));
  // Small parts keep the tests fast; 1 MiB is the backend's lower bound.
  for (const c of ['fault', 'drone', 'connection'] as const) db.policies.put({ ...db.policies.get(c)!, chunkSize: 1 * MiB });
});

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const flags = (f: Record<string, unknown>) => localStorage.setItem('fg.mock', JSON.stringify({ rttMs: 0, bps: 0, ...f }));
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
const json = { 'Content-Type': 'application/json', 'X-Requested-With': 'filegrid' };

const fault = { kind: 'fault', zone: 'dobrogea', substation: 'PT Medgidia 12', eventTime: '2026-11-14T10:00:00+02:00', severity: 'high' };
const drone = { kind: 'drone', lineSection: 'LEA 110 kV', zone: 'muntenia', inspectionDate: '2026-11-14' };

function create(body: Record<string, unknown>, key: string | null = crypto.randomUUID(), headers: Record<string, string> = json) {
  return fetch(url('/uploads'), { method: 'POST', headers: key ? { ...headers, 'Idempotency-Key': key } : headers, body: JSON.stringify(body) });
}
const faultBody = (size = 2.5 * MiB, extra: Record<string, unknown> = {}) => ({
  category: 'fault_records', fileName: 'Avarie_PT_Medgidia.pdf', fileSize: size, mimeType: 'application/pdf', metadata: fault, ...extra,
});

async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function putPart(id: string, n: number, bytes: Uint8Array<ArrayBuffer>, checksum?: string) {
  return fetch(url(`/uploads/${id}/parts/${n}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'filegrid', 'X-Part-SHA256': checksum ?? (await sha(bytes)) },
    body: bytes,
  });
}
async function newFault(size = 2.5 * MiB) {
  const res = await create(faultBody(size));
  return (await res.json()) as { uploadId: string; chunkSize: number; partCount: number };
}
const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('uploads mock: create', () => {
  beforeEach(() => login('teren'));

  it('creates with the policy part size and replays the same key with 200', async () => {
    const key = crypto.randomUUID();
    const first = await create(faultBody(), key);
    expect(first.status).toBe(201);
    expect(first.headers.get('X-Trace-Id')).toBeTruthy();
    const s = await first.json();
    expect(s).toMatchObject({ status: 'open', chunkSize: 1 * MiB, partCount: 3, maxParallel: 2, policyVersion: 3, displayName: 'Avarie_PT_Medgidia.pdf', receivedRanges: [] });
    expect(s.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    const again = await create(faultBody(), key);
    expect(again.status).toBe(200);
    expect((await again.json()).uploadId).toBe(s.uploadId);
    const other = await create(faultBody(3 * MiB), key);
    expect([other.status, (await other.json()).code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('validates the key, the CSRF header and the metadata kind', async () => {
    expect((await (await create(faultBody(), null)).json()).code).toBe('VALIDATION_ERROR');
    const csrf = await create(faultBody(), crypto.randomUUID(), { 'Content-Type': 'application/json' });
    expect([csrf.status, (await csrf.json()).code]).toEqual([403, 'CSRF_REJECTED']);
    const wrong = await create(faultBody(2 * MiB, { metadata: drone }));
    const body = await wrong.json();
    expect([wrong.status, body.code, body.fieldErrors[0].field]).toEqual([422, 'VALIDATION_ERROR', 'metadata.kind']);
  });

  it('enforces the policy size and types', async () => {
    const big = await create(faultBody(51 * MiB));
    expect([big.status, (await big.json()).code]).toEqual([413, 'FILE_TOO_LARGE']);
    const type = await create(faultBody(2 * MiB, { mimeType: 'video/avi' }));
    expect([type.status, (await type.json()).code]).toEqual([422, 'TYPE_NOT_ALLOWED']);
  });

  it('refuses a category the active role cannot upload', async () => {
    await login('racordari');
    const res = await create(faultBody());
    expect([res.status, (await res.json()).code]).toEqual([403, 'FORBIDDEN']);
  });

  it('needs a session', async () => {
    await fetch(url('/auth/logout'), { method: 'POST', headers: json });
    expect((await create(faultBody())).status).toBe(401);
  });
});

describe('uploads mock: parts, status, complete', () => {
  beforeEach(() => login('teren'));

  it('accepts a part once, replays it free, and rejects a wrong checksum or size', async () => {
    const { uploadId } = await newFault();
    const ok = await putPart(uploadId, 1, bytesOf(MiB));
    expect(await ok.json()).toMatchObject({ partNumber: 1, size: MiB, alreadyReceived: false });
    expect((await (await putPart(uploadId, 1, bytesOf(MiB))).json()).alreadyReceived).toBe(true);
    const bad = await putPart(uploadId, 2, bytesOf(MiB), 'f'.repeat(64));
    expect([bad.status, (await bad.json()).code]).toEqual([422, 'PART_CHECKSUM_MISMATCH']);
    const short = await putPart(uploadId, 2, bytesOf(10));
    expect([short.status, (await short.json()).code]).toEqual([422, 'PART_SIZE_MISMATCH']);
    const range = await putPart(uploadId, 4, bytesOf(10));
    expect([range.status, (await range.json()).code]).toEqual([422, 'PART_NUMBER_OUT_OF_RANGE']);
  });

  it('reports received ranges and missing parts at complete', async () => {
    const { uploadId } = await newFault();
    await putPart(uploadId, 1, bytesOf(MiB));
    await putPart(uploadId, 3, bytesOf(MiB / 2));
    const status = await (await fetch(url(`/uploads/${uploadId}`))).json();
    expect(status).toMatchObject({ status: 'open', receivedRanges: [[1, 1], [3, 3]], receivedBytes: 1.5 * MiB, startedAsRole: 'teren', result: null });
    const res = await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'a'.repeat(64), partCount: 3 }) });
    expect([res.status, (await res.json()).missingRanges]).toEqual([409, [[2, 2]]]);
  });

  it('completes with a match, lists the file and refuses later parts', async () => {
    const { uploadId } = await newFault();
    for (const [n, size] of [[1, MiB], [2, MiB], [3, MiB / 2]] as const) await putPart(uploadId, n, bytesOf(size));
    const res = await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'b'.repeat(64), partCount: 3 }) });
    const result = await res.json();
    expect(res.status).toBe(200);
    expect(result).toMatchObject({ status: 'completed', verdict: 'match', clientSha256: 'b'.repeat(64), serverSha256: 'b'.repeat(64), storage: 's3', usedFallback: false, size: 2.5 * MiB });
    expect(result.availableAfterMs).toEqual(expect.any(Number));
    expect(db.list<{ id: string; category: string }>('files').find((f) => f.id === result.fileId)?.category).toBe('fault_records');
    const late = await putPart(uploadId, 1, bytesOf(MiB));
    expect([late.status, (await late.json()).code]).toEqual([409, 'UPLOAD_COMPLETED']);
    const again = await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'b'.repeat(64), partCount: 3 }) });
    expect((await again.json()).fileId).toBe(result.fileId);
  });

  it('answers a hash mismatch with 200, verdict mismatch and no file', async () => {
    flags({ completeMismatch: true });
    const { uploadId } = await newFault(MiB);
    await putPart(uploadId, 1, bytesOf(MiB));
    const res = await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'c'.repeat(64), partCount: 1 }) });
    const result = await res.json();
    expect([res.status, result.verdict, result.fileId, result.status]).toEqual([200, 'mismatch', null, 'failed']);
    expect(result.serverSha256).not.toBe(result.clientSha256);
  });

  it('answers a slow completion with 202 + Retry-After, then the result on GET', async () => {
    flags({ slowComplete: 50 });
    const { uploadId } = await newFault(MiB);
    await putPart(uploadId, 1, bytesOf(MiB));
    const res = await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'd'.repeat(64), partCount: 1 }) });
    expect([res.status, res.headers.get('Retry-After'), (await res.json()).status]).toEqual([202, '2', 'verifying']);
    await new Promise((r) => setTimeout(r, 60));
    const status = await (await fetch(url(`/uploads/${uploadId}`))).json();
    expect([status.status, status.result?.verdict]).toEqual(['completed', 'match']);
  });

  it('hides another user’s upload', async () => {
    const { uploadId } = await newFault();
    await login('dispecerat');
    const res = await fetch(url(`/uploads/${uploadId}`));
    expect([res.status, (await res.json()).code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
  });

  it('cancels: 204, then parts are refused; a completed upload cannot be cancelled', async () => {
    const { uploadId } = await newFault(MiB);
    expect((await fetch(url(`/uploads/${uploadId}`), { method: 'DELETE', headers: json })).status).toBe(204);
    const late = await putPart(uploadId, 1, bytesOf(MiB));
    expect([late.status, (await late.json()).code]).toEqual([409, 'UPLOAD_NOT_OPEN']);
    const done = await newFault(MiB);
    await putPart(done.uploadId, 1, bytesOf(MiB));
    await fetch(url(`/uploads/${done.uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'e'.repeat(64), partCount: 1 }) });
    const del = await fetch(url(`/uploads/${done.uploadId}`), { method: 'DELETE', headers: json });
    expect([del.status, (await del.json()).code]).toEqual([409, 'UPLOAD_COMPLETED']);
  });
});

describe('uploads mock: failure injection', () => {
  beforeEach(() => login('teren'));

  it('fails like a network error when offline', async () => {
    const { uploadId } = await newFault(MiB);
    flags({ offline: true });
    await expect(putPart(uploadId, 1, bytesOf(MiB))).rejects.toThrow();
    await expect(fetch(url('/ping'), { method: 'HEAD' })).rejects.toThrow();
  });

  it('expires the session once with a 401', async () => {
    const { uploadId } = await newFault(MiB);
    flags({ expire401Once: true });
    expect((await putPart(uploadId, 1, bytesOf(MiB))).status).toBe(401);
    expect((await fetch(url('/auth/me'))).status).toBe(401);
    await login('teren');
    expect((await putPart(uploadId, 1, bytesOf(MiB))).status).toBe(200);
  });

  it('corrupts one part once', async () => {
    flags({ corruptPart: 1 });
    const { uploadId } = await newFault(MiB);
    expect((await putPart(uploadId, 1, bytesOf(MiB))).status).toBe(422);
    expect((await putPart(uploadId, 1, bytesOf(MiB))).status).toBe(200);
  });

  it('answers 503 STORAGE_UNAVAILABLE when primary and fallback are down, and uses the fallback otherwise', async () => {
    db.storage.set('S3', 'down');
    const { uploadId } = await newFault(MiB);
    await putPart(uploadId, 1, bytesOf(MiB));
    const done = await (await fetch(url(`/uploads/${uploadId}/complete`), { method: 'POST', headers: json, body: JSON.stringify({ sha256: 'f'.repeat(64), partCount: 1 }) })).json();
    expect([done.storage, done.usedFallback]).toEqual(['ftp', true]);
    db.storage.set('FTP', 'down');
    const next = await newFault(MiB);
    const res = await putPart(next.uploadId, 1, bytesOf(MiB));
    expect([res.status, res.headers.get('Retry-After')]).toEqual([503, '5']);
    expect(await res.json()).toMatchObject({ code: 'STORAGE_UNAVAILABLE', storage: 's3', retryAfterMs: 5000 });
  });

  it('serves HEAD /ping and the policy in the real format', async () => {
    expect((await fetch(url('/ping'), { method: 'HEAD' })).status).toBe(204);
    const policy = (await (await fetch(url('/policies/drone_videos'))).json()) as Policy & { maxConcurrency: number };
    expect(policy).toMatchObject({ category: 'drone_videos', primaryStorage: 's3', fallbackStorage: 'ftp', chunkSize: MiB, maxConcurrency: expect.any(Number) });
  });
});
