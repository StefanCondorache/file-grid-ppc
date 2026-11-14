import { apiUrl } from '@/lib/api/base';
import { csrfHeaders } from '@/lib/api/csrf';
import { ApiError, networkError, toApiError } from '@/lib/api/errors';
import { ro } from '@/lib/i18n/ro';
import { createWorkerHasher, type HashClient } from '@/lib/upload/hasher';

/**
 * Download re-verification (FE-04, upload-engine.md §15). Files up to 64 MiB are buffered, hashed in the shared
 * hashing worker and saved via an anchor. Larger files go to disk as a plain anchor download and the server
 * re-hashes the stored bytes (`POST /files/{id}/verification`), labelled "Verificat de server". The picker-streamed
 * client hash for large files on Chromium is P1.
 */
export const BUFFER_LIMIT = 64 * 1024 * 1024;
const HASH_CHUNK = 8 * 1024 * 1024;

export type DownloadMode = 'client_verified' | 'verify_only' | 'server_verified';
export type VerifiedState = 'verified' | 'server_verified' | 'corrupt';
export type NextStep = 'restore_from_backup' | 'notify_storage_team';

export interface VerifiedDownloadResult {
  mode: DownloadMode;
  state: VerifiedState;
  badge: string;
  expectedSha256: string | null;
  actualSha256: string | null;
  storage: string | null;
  traceId: string | null;
  /** Only for a corrupt file: what the user should do next. */
  nextStep: NextStep | null;
}

export type SaveFile = (blob: Blob, fileName: string) => void;

export interface DownloadArgs {
  fileId: string;
  size: number;
  /** The stored SHA-256 when the caller has it (`GET /files/{id}`); otherwise `X-File-SHA256` / `ETag` is used. */
  expectedSha256?: string | null;
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
  saveFile?: SaveFile;
  /** Used only when `Content-Disposition` carries no name. */
  fileName?: string;
  /** A replica exists, so a corrupt file can be restored (next step "Restaurează din rezervă"). */
  hasFallbackCopy?: boolean;
  /** The storage label the caller knows, shown when a client-side mismatch has no server body. */
  storage?: string | null;
  /** Seams for tests. */
  fetch?: typeof fetch;
  hasher?: HashClient;
  /** Starts a native browser download of a URL (large files). */
  startNativeDownload?: (url: string) => void;
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const norm = (h: string | null): string | null => (h ? h.trim().replace(/^W\//, '').replace(/"/g, '').toLowerCase() : null);

let sharedHasher: HashClient | null = null;
function defaultHasher(): HashClient {
  sharedHasher ??= createWorkerHasher();
  return sharedHasher;
}

function contentUrl(fileId: string): string {
  return apiUrl(`/files/${encodeURIComponent(fileId)}/content`);
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function result(
  mode: DownloadMode,
  state: VerifiedState,
  fields: Partial<Pick<VerifiedDownloadResult, 'expectedSha256' | 'actualSha256' | 'storage' | 'traceId'>>,
  hasFallbackCopy: boolean,
): VerifiedDownloadResult {
  return {
    mode,
    state,
    badge: ro.files.integrity[state],
    expectedSha256: norm(fields.expectedSha256 ?? null),
    actualSha256: norm(fields.actualSha256 ?? null),
    storage: fields.storage ?? null,
    traceId: fields.traceId ?? null,
    nextStep: state === 'corrupt' ? (hasFallbackCopy ? 'restore_from_backup' : 'notify_storage_team') : null,
  };
}

async function readJson(response: Response): Promise<Loose> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as Loose) : {};
  } catch {
    return {};
  }
}

/** `409 FILE_CORRUPT` body (docs/api.md errors: `expectedSha256`, `actualSha256`, `storage`, `traceId`). */
export function corruptFrom409(body: Loose, response: Pick<Response, 'headers'>, mode: DownloadMode, hasFallbackCopy: boolean, expected?: string | null, storage: string | null = null): VerifiedDownloadResult {
  const inner = (body.error && typeof body.error === 'object' ? body.error : body) as Loose;
  const details = (inner.details && typeof inner.details === 'object' ? inner.details : {}) as Loose;
  const pick = (k: string) => str(inner[k]) ?? str(details[k]);
  const fallback = typeof inner.fallbackAvailable === 'boolean' ? inner.fallbackAvailable : hasFallbackCopy;
  return result(
    mode,
    'corrupt',
    {
      expectedSha256: pick('expectedSha256') ?? expected ?? null,
      actualSha256: pick('actualSha256'),
      storage: pick('storage') ?? storage,
      traceId: pick('traceId') ?? str(inner.trace_id) ?? response.headers.get('X-Trace-Id'),
    },
    fallback,
  );
}

/** File name from `Content-Disposition` (`filename*=UTF-8''…` first, then `filename="…"`). */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
      } catch {
        // fall through to the plain parameter
      }
    }
    const plain = /filename\s*=\s*"([^"]+)"/.exec(disposition) ?? /filename\s*=\s*([^;]+)/.exec(disposition);
    if (plain?.[1]) return plain[1].trim();
  }
  return fallback;
}

/** Saves a Blob through a temporary object URL and an `<a download>`; the URL is revoked right after. */
export function saveBlobViaAnchor(blob: Blob, fileName: string, deps: { doc?: Document; url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> } = {}): void {
  const doc = deps.doc ?? document;
  const url = deps.url ?? URL;
  const href = url.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = href;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // The click has queued the download; give the browser a tick before the bytes go away.
    setTimeout(() => url.revokeObjectURL(href), 0);
  }
}

function nativeDownload(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** `POST /files/{id}/verification`: the server re-hashes the stored object. */
export async function verifyOnServer(fileId: string, opts: { signal?: AbortSignal; fetch?: typeof fetch; hasFallbackCopy?: boolean; mode?: DownloadMode } = {}): Promise<VerifiedDownloadResult> {
  const doFetch = opts.fetch ?? fetch;
  const mode = opts.mode ?? 'server_verified';
  const hasFallbackCopy = opts.hasFallbackCopy ?? false;
  let response: Response;
  try {
    response = await doFetch(apiUrl(`/files/${encodeURIComponent(fileId)}/verification`), {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfHeaders('POST'),
      signal: opts.signal,
    });
  } catch (e) {
    throw isAbort(e) ? e : networkError(e);
  }
  const body = await readJson(response);
  if (response.status === 409 && str(body.code)?.toUpperCase() === 'FILE_CORRUPT') return corruptFrom409(body, response, mode, hasFallbackCopy);
  if (!response.ok) throw toApiError(response, body);
  const state = body.state === 'corrupt' ? 'corrupt' : 'server_verified';
  return result(
    mode,
    state,
    { expectedSha256: str(body.expectedSha256), actualSha256: str(body.actualSha256), storage: str(body.storage), traceId: str(body.traceId) ?? response.headers.get('X-Trace-Id') },
    hasFallbackCopy,
  );
}

class CutConnection extends Error {}

type Buffered = { blob: Blob; headerSha256: string | null; fileName: string; traceId: string | null } | { corrupt: VerifiedDownloadResult };

async function fetchBuffered(args: DownloadArgs, doFetch: typeof fetch): Promise<Buffered> {
  let response: Response;
  try {
    response = await doFetch(contentUrl(args.fileId), { credentials: 'same-origin', cache: 'no-store', signal: args.signal });
  } catch (e) {
    throw isAbort(e) ? e : networkError(e);
  }
  if (response.status === 409) {
    const body = await readJson(response);
    if (str(body.code)?.toUpperCase() === 'FILE_CORRUPT' || body.expectedSha256 !== undefined) {
      return { corrupt: corruptFrom409(body, response, 'client_verified', args.hasFallbackCopy ?? false, args.expectedSha256, args.storage ?? null) };
    }
    throw toApiError(response, body);
  }
  if (!response.ok) throw toApiError(response, await readJson(response));
  const headerSha256 = norm(response.headers.get('X-File-SHA256') ?? response.headers.get('ETag'));
  const fileName = fileNameFrom(response.headers.get('Content-Disposition'), args.fileName ?? 'fisier');
  const traceId = response.headers.get('X-Trace-Id');
  if (!response.body) {
    const blob = await response.blob();
    args.onProgress?.(blob.size);
    return { blob, headerSha256, fileName, traceId };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > BUFFER_LIMIT) throw new ApiError(0, 'TOO_LARGE_TO_BUFFER', 'File grew past the buffer limit');
      chunks.push(value as Uint8Array<ArrayBuffer>);
      args.onProgress?.(received);
    }
  } catch (e) {
    if (isAbort(e) || args.signal?.aborted) throw args.signal?.reason instanceof DOMException ? args.signal.reason : new DOMException('Download aborted', 'AbortError');
    if (e instanceof ApiError) throw e;
    // The backend cuts (never ends) the connection when a streamed file's hash turns out wrong.
    throw new CutConnection(e instanceof Error ? e.message : String(e));
  }
  return { blob: new Blob(chunks), headerSha256, fileName, traceId };
}

/**
 * Downloads a file and re-verifies its SHA-256 against the stored one (FE-04).
 * - ≤ 64 MiB: buffered, hashed in the worker, saved via `saveFile` (an anchor by default) only when it matches.
 * - > 64 MiB: native anchor download, then server verification → "Verificat de server".
 * - `409 FILE_CORRUPT`: corrupt result with both hashes, the storage, the trace ID and the next step.
 * - A connection cut mid-body is retried once; if it is cut again the server is asked to verify.
 */
export async function downloadAndVerify(args: DownloadArgs): Promise<VerifiedDownloadResult> {
  const doFetch = args.fetch ?? fetch;
  const hasFallbackCopy = args.hasFallbackCopy ?? false;

  if (args.size > BUFFER_LIMIT) {
    (args.startNativeDownload ?? nativeDownload)(contentUrl(args.fileId));
    return verifyOnServer(args.fileId, { signal: args.signal, fetch: doFetch, hasFallbackCopy });
  }

  let got: Buffered | null = null;
  for (let attempt = 1; attempt <= 2 && !got; attempt++) {
    try {
      got = await fetchBuffered(args, doFetch);
    } catch (e) {
      if (!(e instanceof CutConnection)) throw e;
      if (attempt === 2) return verifyOnServer(args.fileId, { signal: args.signal, fetch: doFetch, hasFallbackCopy, mode: 'client_verified' });
    }
  }
  if (!got) throw new ApiError(0, 'NETWORK', 'Download failed');
  if ('corrupt' in got) return got.corrupt;

  const expected = norm(args.expectedSha256 ?? null) ?? got.headerSha256;
  if (!expected) {
    // Nothing to compare with locally: save, and let the server re-hash the stored bytes.
    (args.saveFile ?? saveBlobViaAnchor)(got.blob, got.fileName);
    return verifyOnServer(args.fileId, { signal: args.signal, fetch: doFetch, hasFallbackCopy });
  }
  const hasher = args.hasher ?? defaultHasher();
  const { sha256 } = await hasher.hash(got.blob, HASH_CHUNK, () => {}, args.signal);
  const actual = norm(sha256);
  if (actual !== expected) {
    return result('client_verified', 'corrupt', { expectedSha256: expected, actualSha256: actual, storage: args.storage ?? null, traceId: got.traceId }, hasFallbackCopy);
  }
  (args.saveFile ?? saveBlobViaAnchor)(got.blob, got.fileName);
  return result('client_verified', 'verified', { expectedSha256: expected, actualSha256: actual, traceId: got.traceId }, hasFallbackCopy);
}
