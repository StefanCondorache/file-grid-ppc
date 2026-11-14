import type { Me } from '@/lib/api/types';

export const WARN_BEFORE_MS = 120_000;

/**
 * Schedules the T−2 min warning and the expiry for the earlier of the absolute and idle deadlines,
 * converted from server time to client time (skew = serverTime − now). Returns a cancel function.
 */
export function scheduleSession(me: Pick<Me, 'serverTime' | 'expiresAt' | 'idleExpiresAt'>, now: number, handlers: { onWarn(): void; onExpire(): void }): () => void {
  const skew = Date.parse(me.serverTime) - now;
  const deadline = Math.min(Date.parse(me.expiresAt), Date.parse(me.idleExpiresAt)) - skew;
  const warnIn = Math.max(0, deadline - WARN_BEFORE_MS - now);
  const expireIn = Math.max(0, deadline - now);
  const warn = setTimeout(handlers.onWarn, warnIn);
  const expire = setTimeout(handlers.onExpire, expireIn);
  return () => {
    clearTimeout(warn);
    clearTimeout(expire);
  };
}

/** Client-side deadline in ms since epoch (for the dialog countdown). */
export function sessionDeadline(me: Pick<Me, 'serverTime' | 'expiresAt' | 'idleExpiresAt'>, now: number): number {
  return Math.min(Date.parse(me.expiresAt), Date.parse(me.idleExpiresAt)) - (Date.parse(me.serverTime) - now);
}
