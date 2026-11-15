import createClient from 'openapi-fetch';
import { absoluteBase } from './base';
import { csrfHeaders } from './csrf';
import { ApiError, networkError, toApiError } from './errors';
import type { paths } from './schema';

export const api = createClient<paths>({
  baseUrl: absoluteBase(),
  credentials: 'same-origin',
  // Resolved per call so the global fetch can be swapped (tests).
  fetch: (request: Request) => fetch(request),
});

api.use({
  onRequest({ request }) {
    for (const [k, v] of Object.entries(csrfHeaders(request.method))) request.headers.set(k, v);
    return request;
  },
});

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Resolve the data or throw one ApiError (network failures become code NETWORK). */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await call;
  } catch (cause) {
    throw cause instanceof ApiError ? cause : networkError(cause);
  }
  if (!result.response.ok) throw toApiError(result.response, result.error);
  return result.data as T;
}
