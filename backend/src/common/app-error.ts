import { currentTraceId } from '../observability/trace-context';

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * The one error body of the API (docs/api.md, ADR-0010): a stable UPPER_SNAKE `code`, a Romanian
 * `message` that is safe to show, the `traceId`, and optional extras (field errors, hashes, storage).
 */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly traceId: string | null;
  readonly fieldErrors?: readonly FieldError[];
  readonly [extra: string]: unknown;
}

/** An expected failure: HTTP status, stable code, safe message, optional extras and headers. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extras: Readonly<Record<string, unknown>> = {},
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorBody(
  code: string,
  message: string,
  extras: Readonly<Record<string, unknown>> = {},
): ErrorBody {
  return { code, message, traceId: currentTraceId() ?? null, ...extras };
}

export const notFound = (message = 'Resursa nu există.'): AppError =>
  new AppError(404, 'NOT_FOUND', message);

export const forbidden = (message = 'Nu aveți dreptul să faceți această acțiune.'): AppError =>
  new AppError(403, 'FORBIDDEN', message);

export function retryAfter(seconds: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) };
}

/** 503 CATEGORY_BUSY: too much at once for this category (bulkhead full, storage pool exhausted). */
export function categoryBusy(): AppError {
  return new AppError(
    503,
    'CATEGORY_BUSY',
    'Prea multe operații simultane pentru această categorie. Reîncercați în câteva secunde.',
    { retryAfterMs: 2000 },
    retryAfter(2),
  );
}
