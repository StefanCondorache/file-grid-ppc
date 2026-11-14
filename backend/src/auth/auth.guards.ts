import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AppError } from '../common/app-error';
import { type Capability, can } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuthService, unauthenticated } from './auth.service';
import type { AuthRequest } from './auth.types';
import { readCookie, sessionCookieName, setSessionCookie } from './session-cookie';

const BEARER = /^Bearer\s+(\S+)$/i;
const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export const REQUIRED_CAPABILITIES = 'filegrid:capabilities';
export const RequireCapabilities = (
  ...capabilities: Capability[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_CAPABILITIES, capabilities);

/** The session token of a request: the cookie (browser) or a bearer header (scripts, tests). */
export function sessionToken(
  request: AuthRequest,
  config: AppConfig,
): { token: string; viaCookie: boolean } | undefined {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? BEARER.exec(header) : null;
  if (match) return { token: match[1], viaCookie: false };
  const cookie = readCookie(request, sessionCookieName(config));
  return cookie ? { token: cookie, viaCookie: true } : undefined;
}

/**
 * Requires a valid session, puts the principal on the request, slides the idle window, and checks
 * the capabilities named by @RequireCapabilities against the active role.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthRequest>();
    const presented = sessionToken(request, this.config);
    if (!presented) throw unauthenticated();
    const { principal, refreshed } = await this.auth.verify(presented.token, presented.viaCookie);
    if (refreshed) {
      setSessionCookie(
        http.getResponse<Response>(),
        this.config,
        refreshed.token,
        refreshed.maxAgeS,
      );
    }
    request.principal = principal;
    const required =
      this.reflector.getAllAndOverride<Capability[] | undefined>(REQUIRED_CAPABILITIES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (!required.every((capability) => can(principal.activeRole, capability))) {
      throw new AppError(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
    }
    return true;
  }
}

/** Demo endpoints exist only in demo mode; otherwise they answer 404, as if they were not there. */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (!this.config.demoMode) throw new AppError(404, 'NOT_FOUND', 'Resursa nu există.');
    return true;
  }
}

/** Smart meters (the simulator) authenticate with X-API-Key, compared in constant time. */
@Injectable()
export class MeterKeyGuard implements CanActivate {
  private readonly keyDigest: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.keyDigest = sha256(config.meterApiKey);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const presented = request.headers['x-api-key'];
    if (typeof presented === 'string' && presented.length > 0) {
      const digest = sha256(presented);
      if (timingSafeEqual(digest, this.keyDigest)) {
        request.meterKeyId = digest.toString('hex').slice(0, 8);
        return true;
      }
    }
    throw new AppError(
      401,
      'INVALID_API_KEY',
      'Cheia API a contorului lipsește sau nu este validă.',
    );
  }
}
