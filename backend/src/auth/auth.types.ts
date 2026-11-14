import type { Request } from 'express';
import type { Role } from '../common/domain';

export interface AuthUser {
  readonly username: string;
  readonly role: Role;
}

/** The Express request after the auth guards ran. */
export type AuthRequest = Request & { user?: AuthUser; meterKeyId?: string };

export interface LoginResult {
  readonly access_token: string;
  readonly token_type: 'bearer';
  readonly expires_in: number;
  readonly user: AuthUser;
}
