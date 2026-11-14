import { apiUrl } from '@/lib/api/base';
import { csrfHeaders } from '@/lib/api/csrf';
import { ApiError, networkError, toApiError } from '@/lib/api/errors';
import type { CompleteResult, CreateUploadRequest, PartReceipt, UploadErrorBody, UploadSession, UploadStatus } from './contract';
import { UPLOAD_CATEGORIES, type PolicySnapshot, type StorageId, type UploadCategoryId } from './types';

export type CompleteOutcome = { kind: 'done'; result: CompleteResult } | { kind: 'verifying'; retryAfterMs: number };

/** JSON calls of the uploads group (docs/api.md "Resumable upload"). The engine never builds URLs itself. */
export interface UploadApi {
  policy(category: UploadCategoryId): Promise<PolicySnapshot>;
  create(req: CreateUploadRequest, idempotencyKey: string): Promise<UploadSession>;
  status(uploadId: string): Promise<UploadStatus>;
  complete(uploadId: string, sha256: string, partCount: number): Promise<CompleteOutcome>;
  cancel(uploadId: string): Promise<void>;
}

export interface PartSend {
  uploadId: string;
  partNumber: number;
  body: Blob;
  sha256Hex: string;
  signal: AbortSignal;
  onProgress(sentBytes: number): void;
}

/** One part PUT; resolves with the receipt, rejects with ApiError (status 0 = network) or an AbortError. */
export interface PartTransport {
  send(args: PartSend): Promise<PartReceipt>;
}

/** The extras of an upload error body (missingRanges, storage, …), or null for other errors. */
export function errorBody(error: unknown): UploadErrorBody | null {
  return error instanceof ApiError && error.details && typeof error.details === 'object' ? (error.details as UploadErrorBody) : null;
}

/** ApiError with the whole body kept as `details`: the backend puts extras at the top level of the error body. */
function uploadError(response: Pick<Response, 'status' | 'headers'>, body: unknown): ApiError {
  const e = toApiError(response, body);
  return new ApiError(e.status, e.code, e.message, e.traceId, e.fieldErrors, e.retryAfterMs, body && typeof body === 'object' ? body : null);
}

function invalid(what: string): ApiError {
  return new ApiError(0, 'BAD_RESPONSE', `Unexpected ${what} from the server`);
}

const LEGACY_CATEGORY: Record<string, UploadCategoryId> = { fault: 'fault_records', connection: 'connection_documents', drone: 'drone_videos' };
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const storage = (v: unknown): StorageId | null => {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 's3' || s === 'ftp' || s === 'db' ? s : null;
};

/** Validates a policy body (never trust external data); also accepts the proposal's ids while other slices migrate. */
export function toPolicySnapshot(raw: unknown): PolicySnapshot {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const category = (UPLOAD_CATEGORIES as readonly string[]).includes(String(p.category)) ? (p.category as UploadCategoryId) : LEGACY_CATEGORY[String(p.category)];
  const primary = storage(p.primaryStorage);
  if (!category || !primary || !isNum(p.version) || !isNum(p.chunkSize) || !isNum(p.maxParallel) || !isNum(p.maxFileSize) || !Array.isArray(p.allowedTypes)) {
    throw invalid('policy');
  }
  return {
    category,
    version: p.version,
    primaryStorage: primary,
    fallbackStorage: storage(p.fallbackStorage),
    encryptionAtRest: p.encryptionAtRest === true,
    chunkSize: p.chunkSize,
    maxParallel: p.maxParallel,
    maxFileSize: p.maxFileSize,
    allowedTypes: p.allowedTypes.filter((t): t is string => typeof t === 'string'),
  };
}

function absolute(path: string): string {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'http://localhost';
  return new URL(apiUrl(path), origin).href;
}

export function createUploadApi(fetchFn: typeof fetch = (...a) => fetch(...a)): UploadApi {
  async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...csrfHeaders(method), ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchFn(absolute(path), { method, headers, credentials: 'same-origin', cache: 'no-store', body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch (cause) {
      throw networkError(cause);
    }
    if (!res.ok && res.status !== 202) throw uploadError(res, await res.json().catch(() => null));
    return res;
  }
  const json = async <T>(res: Response): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch {
      throw invalid('body');
    }
  };
  const id = (uploadId: string) => encodeURIComponent(uploadId);

  return {
    async policy(category) {
      return toPolicySnapshot(await json(await call('GET', `/policies/${category}`)));
    },
    async create(req, idempotencyKey) {
      return json<UploadSession>(await call('POST', '/uploads', { body: req, headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    async status(uploadId) {
      return json<UploadStatus>(await call('GET', `/uploads/${id(uploadId)}`));
    },
    async complete(uploadId, sha256, partCount) {
      const res = await call('POST', `/uploads/${id(uploadId)}/complete`, { body: { sha256, partCount } });
      if (res.status === 202) {
        const after = Number(res.headers.get('Retry-After'));
        return { kind: 'verifying', retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 2000 };
      }
      return { kind: 'done', result: await json<CompleteResult>(res) };
    },
    async cancel(uploadId) {
      try {
        await call('DELETE', `/uploads/${id(uploadId)}`);
      } catch (error) {
        // DELETE is idempotent on the client: an upload that no longer exists is already cancelled.
        if (error instanceof ApiError && error.status === 404) return;
        throw error;
      }
    },
  };
}

export interface XhrLike {
  status: number;
  responseText: string;
  upload: { onprogress: ((e: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body: Blob): void;
  abort(): void;
}

/** Floor for the total part timeout: a 16 MiB part at 32 KiB/s still gets its 512 s (Traefik allows 900 s). */
const MIN_BYTES_PER_S = 32 * 1024;

/**
 * Part PUTs over XHR (UE-5): upload progress, abort, and a stall watchdog (no progress for `stallMs`, or over the
 * total budget) that aborts and reports a network error so the scheduler retries. The body is the lazy Blob slice:
 * the browser streams it from disk, the JS heap never holds the bytes.
 */
export function createXhrTransport(opts: { makeXhr?: () => XhrLike; stallMs?: number; totalMs?: number } = {}): PartTransport {
  const makeXhr = opts.makeXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike);
  const stallMs = opts.stallMs ?? 30_000;
  const totalMs = opts.totalMs ?? 120_000;

  return {
    send({ uploadId, partNumber, body, sha256Hex, signal, onProgress }) {
      return new Promise<PartReceipt>((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException('Part aborted', 'AbortError'));
        const xhr = makeXhr();
        let sent = 0;
        let stalled = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const budget = Math.max(totalMs, (body.size / MIN_BYTES_PER_S) * 1000);
        const totalTimer = setTimeout(() => stall(), budget);
        const cleanup = () => {
          clearTimeout(stallTimer);
          clearTimeout(totalTimer);
          signal.removeEventListener('abort', onAbort);
        };
        const stall = () => {
          stalled = true;
          xhr.abort();
        };
        const armStall = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(stall, stallMs);
        };
        const onAbort = () => xhr.abort();

        xhr.open('PUT', apiUrl(`/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Part-SHA256', sha256Hex);
        for (const [k, v] of Object.entries(csrfHeaders('PUT'))) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          sent = e.loaded;
          onProgress(e.loaded);
          armStall();
        };
        xhr.onload = () => {
          cleanup();
          let parsed: unknown = null;
          try {
            parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            parsed = null; // a proxy error page: classified by status below
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            const receipt = parsed as Partial<PartReceipt> | null;
            // An unparsable 2xx (a proxy page) is retried like a network error; the PUT is idempotent.
            if (typeof receipt?.partNumber !== 'number') return reject(invalid('part receipt'));
            if (sent < body.size) onProgress(body.size);
            resolve(receipt as PartReceipt);
            return;
          }
          const headers = new Headers();
          for (const h of ['Retry-After', 'X-Trace-Id']) {
            const v = xhr.getResponseHeader(h);
            if (v) headers.set(h, v);
          }
          reject(uploadError({ status: xhr.status, headers }, parsed));
        };
        xhr.onerror = () => {
          cleanup();
          reject(networkError(new Error('Part upload failed at the network level')));
        };
        xhr.onabort = () => {
          cleanup();
          reject(stalled ? networkError(new Error('Part upload stalled')) : new DOMException('Part aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        armStall();
        xhr.send(body);
      });
    },
  };
}
