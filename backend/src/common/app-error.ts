import { currentTraceId } from '../observability/trace-context';

export interface ErrorBody {
  error: { code: string; message: string; trace_id: string | null; details: unknown };
}

/** An expected failure with a stable, machine-readable `code` for clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorBody(code: string, message: string, details: unknown = null): ErrorBody {
  return { error: { code, message, trace_id: currentTraceId() ?? null, details } };
}
