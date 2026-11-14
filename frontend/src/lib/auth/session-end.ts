import { ApiError } from '@/lib/api/errors';

type Handler = (error: ApiError) => void;
let handler: Handler | null = null;

/** AuthGate registers how the session ends; returns an unregister function. */
export function setSessionEndHandler(fn: Handler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** A 401 that means "no valid session" (a wrong password on login is not one). */
export function isSessionEnding(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && error.code !== 'INVALID_CREDENTIALS';
}

export function notifyUnauthenticated(error: ApiError): void {
  handler?.(error);
}
