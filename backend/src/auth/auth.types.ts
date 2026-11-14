import type { Request } from 'express';
import type { Role } from '../common/domain';

/** The person behind a request, after the session was verified. */
export interface Principal {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  /** The account's own role. */
  readonly role: Role;
  /** The role used for permission checks: `role`, or the demo persona an admin switched to. */
  readonly activeRole: Role;
  readonly actingRoleExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly idleExpiresAt: Date;
  /** True when the session came from the cookie (the browser), false for a bearer token. */
  readonly viaCookie: boolean;
}

/** The Express request after the auth guards ran. */
export type AuthRequest = Request & { principal?: Principal; meterKeyId?: string };

export interface UserRef {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface MeResponse {
  readonly user: UserRef;
  readonly realUser: UserRef;
  readonly activeRole: Role;
  readonly roles: readonly Role[];
  readonly capabilities: readonly string[];
  readonly demoMode: boolean;
  readonly actingRoleExpiresAt: string | null;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly serverTime: string;
}

/** Claims of the session token (HS256 JWT, carried by the cookie or a bearer header). */
export interface SessionClaims {
  readonly sub: string;
  readonly uid: string;
  readonly name: string;
  readonly role: Role;
  /** Acting (demo) role and its expiry, epoch seconds. */
  readonly act?: Role;
  readonly actExp?: number;
  /** Idle expiry, epoch seconds; refreshed while the session is used. */
  readonly idle: number;
  readonly iat: number;
  readonly exp: number;
}
