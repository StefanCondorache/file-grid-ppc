import type { Request } from 'express';

/**
 * The client of a request: Express's request.ip, which follows X-Forwarded-For only through the
 * proxies in TRUSTED_PROXY_CIDRS (app.setup.ts), with IPv4-mapped IPv6 (`::ffff:a.b.c.d`) written
 * as plain IPv4. Used by the login rate limiter and the audit trail.
 */
export function clientIpOf(request: Request): string | null {
  const ip = request.ip ?? request.socket?.remoteAddress;
  if (!ip) return null;
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice('::ffff:'.length) : ip;
}
