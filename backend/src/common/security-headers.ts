import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Defensive headers on every answer (HSTS comes from Traefik):
 * - `X-Content-Type-Options: nosniff`: a JSON body is never sniffed into HTML or script;
 * - `Referrer-Policy: no-referrer`: API URLs (file ids, trace ids) never leak in a Referer;
 * - `Cache-Control: no-store`: sessions, user data and file metadata never land in a shared or
 *   browser cache. Routes that need other caching set their own value after this one: file
 *   content (`private, no-store`, with its ETag, Range and If-Range) and the event stream
 *   (`no-cache, no-transform`).
 */
export function securityHeaders(): RequestHandler {
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    next();
  };
}
