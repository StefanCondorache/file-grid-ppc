import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuthService } from './auth.service';
import type { AuthRequest } from './auth.types';

const BEARER = /^Bearer\s+(\S+)$/i;
const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

/** Requires a valid bearer JWT and puts the user on the request. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!match) {
      throw new AppError(401, 'unauthorized', 'Missing bearer token', null, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    request.user = await this.auth.verifyToken(match[1]);
    return true;
  }
}

/** Runs after JwtAuthGuard: only admins pass. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (request.user?.role !== 'admin') {
      throw new AppError(403, 'forbidden', 'This action needs the admin role');
    }
    return true;
  }
}

/** Smart meters authenticate with X-API-Key; keys are compared in constant time. */
@Injectable()
export class MeterKeyGuard implements CanActivate {
  private readonly keyDigests: readonly Buffer[];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.keyDigests = config.meterApiKeys.map((key) => sha256(key));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const presented = request.headers['x-api-key'];
    if (typeof presented === 'string' && presented.length > 0) {
      const digest = sha256(presented);
      // Check every key so the time taken does not depend on which one matched.
      const matched = this.keyDigests.reduce(
        (found, expected) => timingSafeEqual(digest, expected) || found,
        false,
      );
      if (matched) {
        request.meterKeyId = digest.toString('hex').slice(0, 8);
        return true;
      }
    }
    throw new AppError(401, 'invalid_api_key', 'Missing or invalid meter API key');
  }
}
