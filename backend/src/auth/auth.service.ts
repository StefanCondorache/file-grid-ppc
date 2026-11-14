import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { ROLES, type Role } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import type { AuthUser, LoginResult } from './auth.types';
import { LoginRateLimiter } from './login-rate-limiter';
import { hashPassword, verifyPassword } from './password';

export const JWT_ISSUER = 'filegrid';
export const JWT_AUDIENCE = 'filegrid-api';
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const BEARER_CHALLENGE = { 'WWW-Authenticate': 'Bearer' };

function invalidToken(): AppError {
  return new AppError(401, 'invalid_token', 'Invalid or expired token', null, BEARER_CHALLENGE);
}

@Injectable()
export class AuthService {
  // Verified against when the username is unknown, so both failures take the same time.
  private readonly timingEqualiser = hashPassword('filegrid-timing-equaliser');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly limiter: LoginRateLimiter,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, clientIp: string): Promise<LoginResult> {
    const limiterKey = `${clientIp}|${username.toLowerCase()}`;
    this.limiter.check(limiterKey);

    const user = await this.authenticate(username, password);
    if (!user) {
      this.limiter.recordFailure(limiterKey);
      await this.audit.record(this.db, {
        actor: username,
        action: 'auth.login',
        outcome: 'failure',
      });
      throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
    }

    this.limiter.reset(limiterKey);
    const expiresIn = this.config.jwtTtlMinutes * 60;
    const token = await this.jwt.signAsync(
      { sub: user.username, role: user.role },
      {
        secret: this.config.jwtSecret,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn,
      },
    );
    await this.audit.record(this.db, {
      actor: user.username,
      action: 'auth.login',
      outcome: 'success',
    });
    return { access_token: token, token_type: 'bearer', expires_in: expiresIn, user };
  }

  /** Accepts only HS256 tokens we issued: signature, iss, aud, exp, iat, sub and role. */
  async verifyToken(token: string): Promise<AuthUser> {
    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw invalidToken();
    }
    const { sub, role, exp, iat } = claims;
    if (
      typeof sub !== 'string' ||
      typeof exp !== 'number' ||
      typeof iat !== 'number' ||
      typeof role !== 'string' ||
      !ROLE_SET.has(role)
    ) {
      throw invalidToken();
    }
    return { username: sub, role: role as Role };
  }

  private async authenticate(username: string, password: string): Promise<AuthUser | null> {
    const user = await this.db
      .selectFrom('users')
      .select(['username', 'password_hash', 'role'])
      .where('username', '=', username)
      .executeTakeFirst();
    const valid = await verifyPassword(
      user?.password_hash ?? (await this.timingEqualiser),
      password,
    );
    return user && valid ? { username: user.username, role: user.role } : null;
  }
}
