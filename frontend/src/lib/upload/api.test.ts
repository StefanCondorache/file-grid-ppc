import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as client, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { resetUploadMocks, setUploadMockFlags } from '@/mocks/handlers/uploads';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { createUploadApi, createXhrTransport, errorBody, toPolicySnapshot, type XhrLike } from './api';
import { partsToRanges, rangesToParts, type CreateUploadRequest } from './contract';

const MiB = 1024 * 1024;

describe('part ranges', () => {
  it('converts inclusive ranges both ways', () => {
    expect(rangesToParts([[1, 3], [5, 5]])).toEqual([1, 2, 3, 5]);
    expect(partsToRanges([5, 1, 3, 2, 2])).toEqual([[1, 3], [5, 5]]);
    expect(partsToRanges([])).toEqual([]);
  });
});

describe('policy snapshot', () => {
  it('reads the real format and tolerates the proposal ids', () => {
    const base = { version: 3, encryptionAtRest: false, chunkSize: 16 * MiB, maxParallel: 4, maxFileSize: 4096 * MiB, allowedTypes: ['video/mp4'] };
    expect(toPolicySnapshot({ ...base, category: 'drone_videos', primaryStorage: 'ftp', fallbackStorage: 's3' })).toEqual({ ...base, category: 'drone_videos', primaryStorage: 'ftp', fallbackStorage: 's3' });
    expect(toPolicySnapshot({ ...base, category: 'drone', primaryStorage: 'S3', fallbackStorage: null })).toMatchObject({ category: 'drone_videos', primaryStorage: 's3', fallbackStorage: null });
    expect(() => toPolicySnapshot({ ...base, category: 'drone_videos', primaryStorage: 's3', chunkSize: 'x' })).toThrow(ApiError);
  });
});

describe('upload API against the mock contract', () => {
  const server = setupServer();
  const uploads = createUploadApi();
  beforeAll(async () => {
    server.use(...(await buildHandlers(['auth', 'uploads', 'policies'])));
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    db.reset();
    resetUploadMocks();
    setUploadMockFlags({ rttMs: 0, bps: 0 });
    db.policies.put({ ...db.policies.get('fault')!, chunkSize: 1 * MiB });
    await unwrap(client.POST('/auth/login', { body: { username: 'teren', password: SEED_PASSWORD } }));
  });

  const req: CreateUploadRequest = {
    category: 'fault_records',
    fileName: 'Avarie.pdf',
    fileSize: 1.5 * MiB,
    mimeType: 'application/pdf',
    metadata: { kind: 'fault', zone: 'banat', substation: 'PT 3', eventTime: '2026-11-14T08:00:00Z', severity: 'medium' },
  };

  it('reads a policy snapshot', async () => {
    expect(await uploads.policy('fault_records')).toMatchObject({ category: 'fault_records', chunkSize: MiB, primaryStorage: 's3', version: 3 });
  });

  it('creates idempotently and reads the status', async () => {
    const key = crypto.randomUUID();
    const s = await uploads.create(req, key);
    expect(s).toMatchObject({ chunkSize: MiB, partCount: 2, receivedRanges: [] });
    expect((await uploads.create(req, key)).uploadId).toBe(s.uploadId);
    expect(await uploads.status(s.uploadId)).toMatchObject({ uploadId: s.uploadId, status: 'open', partCount: 2 });
  });

  it('turns error bodies into ApiError with the extras kept', async () => {
    const e = await uploads.create({ ...req, fileSize: 60 * MiB }, crypto.randomUUID()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).code, errorBody(e)?.maxFileSize]).toEqual([413, 'FILE_TOO_LARGE', 50 * MiB]);
    const s = await uploads.create(req, crypto.randomUUID());
    const missing = await uploads.complete(s.uploadId, 'a'.repeat(64), 2).catch((x: unknown) => x);
    expect([(missing as ApiError).code, errorBody(missing)?.missingRanges]).toEqual(['PARTS_MISSING', [[1, 2]]]);
    expect((missing as ApiError).traceId).toMatch(/^mock-/);
  });

  it('maps 202 to verifying with the Retry-After delay', async () => {
    setUploadMockFlags({ rttMs: 0, bps: 0, slowComplete: 10_000 });
    const s = await uploads.create({ ...req, fileSize: MiB }, crypto.randomUUID());
    const body = new Uint8Array(MiB);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (b) => b.toString(16).padStart(2, '0')).join('');
    await fetch(new URL(`/api/v1/uploads/${s.uploadId}/parts/1`, location.origin), {
      method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'filegrid', 'X-Part-SHA256': sha },
    });
    expect(await uploads.complete(s.uploadId, sha, 1)).toEqual({ kind: 'verifying', retryAfterMs: 2000 });
  });

  it('cancels, and a second cancel of a gone upload is not an error', async () => {
    const s = await uploads.create(req, crypto.randomUUID());
    await uploads.cancel(s.uploadId);
    await expect(uploads.cancel('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });

  it('reports a network failure as ApiError NETWORK (status 0)', async () => {
    setUploadMockFlags({ offline: true });
    const e = await uploads.status('00000000-0000-0000-0000-000000000000').catch((x: unknown) => x);
    expect([(e as ApiError).status, (e as ApiError).code]).toEqual([0, 'NETWORK']);
  });
});

class FakeXhr implements XhrLike {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  responseText = '';
  aborted = false;
  responseHeaders: Record<string, string> = {};
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(k: string) {
    return this.responseHeaders[k] ?? null;
  }
  send(body: Blob) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders = headers;
    this.onload?.();
  }
}

describe('XHR part transport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const transport = () => createXhrTransport({ makeXhr: () => new FakeXhr(), stallMs: 30_000, totalMs: 120_000 });
  const args = (over: Partial<Parameters<ReturnType<typeof transport>['send']>[0]> = {}) => ({
    uploadId: 'u1', partNumber: 2, body: new Blob([new Uint8Array(10)]), sha256Hex: 'c'.repeat(64), signal: new AbortController().signal, onProgress: () => {}, ...over,
  });

  it('PUTs the raw part with the checksum and CSRF headers, forwarding progress', async () => {
    const progress: number[] = [];
    const run = transport().send(args({ onProgress: (b) => progress.push(b) }));
    const x = FakeXhr.last!;
    expect([x.method, x.url]).toEqual(['PUT', '/api/v1/uploads/u1/parts/2']);
    expect(x.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': 'c'.repeat(64), 'X-Requested-With': 'filegrid' });
    x.upload.onprogress?.({ loaded: 4 });
    x.respond(200, { partNumber: 2, size: 10, sha256: 'c'.repeat(64), alreadyReceived: false });
    expect(await run).toEqual({ partNumber: 2, size: 10, sha256: 'c'.repeat(64), alreadyReceived: false });
    expect(progress).toEqual([4, 10]); // the last value is synthetic: mocks may not emit upload progress
  });

  it('rejects an error status with an ApiError carrying the body and Retry-After', async () => {
    const run = transport().send(args());
    FakeXhr.last!.respond(503, { code: 'STORAGE_UNAVAILABLE', message: 'x', traceId: 't1', storage: 's3' }, { 'Retry-After': '5', 'X-Trace-Id': 't1' });
    const e = await run.catch((x: unknown) => x);
    expect([(e as ApiError).status, (e as ApiError).code, (e as ApiError).retryAfterMs, errorBody(e)?.storage]).toEqual([503, 'STORAGE_UNAVAILABLE', 5000, 's3']);
  });

  it('rejects a network failure as NETWORK and an abort as AbortError', async () => {
    const net = transport().send(args());
    FakeXhr.last!.onerror?.();
    expect(await net.catch((x: ApiError) => [x.status, x.code])).toEqual([0, 'NETWORK']);
    const ac = new AbortController();
    const aborted = transport().send(args({ signal: ac.signal }));
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last!.aborted).toBe(true);
  });

  it('aborts a stalled part as a network error', async () => {
    const run = transport().send(args()).catch((e: ApiError) => [e.status, e.code]);
    const x = FakeXhr.last!;
    await vi.advanceTimersByTimeAsync(20_000);
    x.upload.onprogress?.({ loaded: 1 }); // progress resets the stall watchdog
    await vi.advanceTimersByTimeAsync(29_000);
    expect(x.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(x.aborted).toBe(true);
    expect(await run).toEqual([0, 'NETWORK']);
  });
});
