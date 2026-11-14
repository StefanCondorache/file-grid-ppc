import type { Request, Response } from 'express';
import type { AppConfig } from '../config/config';

/**
 * The session cookie from ADR-0006: `__Host-fg_session`, Secure, HttpOnly, SameSite=Strict, Path=/,
 * no Domain. Browsers only accept the `__Host-` prefix on Secure cookies, so plain-HTTP local runs
 * (COOKIE_SECURE=false) use the name `fg_session` instead.
 */
export function sessionCookieName(config: AppConfig): string {
  return config.cookieSecure ? '__Host-fg_session' : 'fg_session';
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSessionCookie(
  response: Response,
  config: AppConfig,
  token: string,
  maxAgeS: number,
): void {
  const attributes = [
    `${sessionCookieName(config)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeS))}`,
    ...(config.cookieSecure ? ['Secure'] : []),
  ];
  response.append('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(response: Response, config: AppConfig): void {
  setSessionCookie(response, config, '', 0);
}
