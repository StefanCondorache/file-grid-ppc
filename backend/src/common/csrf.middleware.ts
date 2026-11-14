import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorBody } from './app-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_SITE_FETCH = new Set(['same-origin', 'none']);

function originMatchesHost(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * CSRF guard from ADR-0006 for browser (cookie) requests: a state-changing request must carry
 * `X-Requested-With: filegrid` (a custom header a cross-site form cannot set) and must not come
 * from a foreign Origin / Sec-Fetch-Site. Requests that authenticate with a header (bearer token,
 * meter X-API-Key) cannot be forged by a browser and skip the check. No CORS is served at all.
 */
export function csrfMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) return next();
    if (request.headers.authorization || request.headers['x-api-key']) return next();
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    const rejected =
      request.headers['x-requested-with'] !== 'filegrid' ||
      (typeof fetchSite === 'string' && !SAME_SITE_FETCH.has(fetchSite)) ||
      (typeof origin === 'string' &&
        origin !== 'null' &&
        !originMatchesHost(origin, Array.isArray(host) ? host[0] : host));
    if (!rejected) return next();
    response
      .status(403)
      .json(errorBody('CSRF_REJECTED', 'Cererea a fost respinsă (protecție CSRF).'));
  };
}
