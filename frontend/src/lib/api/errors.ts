export type FieldError = { field: string; code: string; message: string };

/** One error type for every failure (ADR-0010); `message` is never shown when a Romanian catalogue entry exists. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly traceId: string | null = null,
    readonly fieldErrors: FieldError[] = [],
    readonly retryAfterMs: number | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE', 422: 'VALIDATION_ERROR', 429: 'RATE_LIMITED', 503: 'STORAGE_UNAVAILABLE',
};

type Loose = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Accepts the proposal shape {code,message,traceId,fieldErrors} and the NestJS envelope {error:{code,message,trace_id,details}}. */
export function toApiError(response: Pick<Response, 'status' | 'headers'>, body: unknown): ApiError {
  const outer = (body && typeof body === 'object' ? body : {}) as Loose;
  const inner = (outer.error && typeof outer.error === 'object' ? outer.error : outer) as Loose;
  const rawCode = str(inner.code) ?? STATUS_CODES[response.status] ?? 'HTTP_ERROR';
  const code = rawCode.toUpperCase();
  const traceId = str(inner.traceId) ?? str(inner.trace_id) ?? response.headers.get('X-Trace-Id');
  const fieldErrors = Array.isArray(inner.fieldErrors) ? (inner.fieldErrors as FieldError[]) : [];
  const retryAfter = response.headers.get('Retry-After');
  const retryAfterMs = typeof inner.retryAfterMs === 'number' ? inner.retryAfterMs : retryAfter ? Number(retryAfter) * 1000 : null;
  return new ApiError(response.status, code, str(inner.message) ?? `HTTP ${response.status}`, traceId, fieldErrors, retryAfterMs, inner.details ?? null);
}

export function networkError(cause: unknown): ApiError {
  return new ApiError(0, 'NETWORK', cause instanceof Error ? cause.message : 'Network error');
}
