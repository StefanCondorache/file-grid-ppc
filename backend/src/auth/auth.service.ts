import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { ROLES, type Role, capabilitiesOf } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import type { MeResponse, Principal, SessionClaims, UserRef } from './auth.types';
import { LoginRateLimiter } from './login-rate-limiter';
import { hashPassword, verifyPassword } from './password';

export const JWT_ISSUER = 'filegrid';
export const JWT_AUDIENCE = 'filegrid-api';
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
/** Re-issue the cookie when at least this much idle time was used up (avoids a Set-Cookie per call). */
const IDLE_REFRESH_STEP_S = 60;
const MAX_ACTING_MINUTES = 120;

const nowS = (): number => Math.floor(Date.now() / 1000);
const iso = (epochS: number): string => new Date(epochS * 1000).toISOString();

export function unauthenticated(): AppError {
  return new AppError(
    401,
    'UNAUTHENTICATED',
    'Sesiunea lipsește sau a expirat.',
    {},
    {
      'WWW-Authenticate': 'Bearer',
    },
  );
}

export interface IssuedSession {
  readonly token: string;
  readonly principal: Principal;
  /** Seconds until the absolute expiry: the cookie's Max-Age. */
  readonly maxAgeS: number;
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

  async login(username: string, password: string, clientIp: string): Promise<IssuedSession> {
    const limiterKey = `${clientIp}|${username.toLowerCase()}`;
    this.limiter.check(limiterKey);

    const user = await this.authenticate(username, password);
    if (!user) {
      this.limiter.recordFailure(limiterKey);
      await this.audit.record(this.db, { actor: username, action: 'login', outcome: 'failure' });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Utilizator sau parolă greșită.');
    }

    this.limiter.reset(limiterKey);
    const issuedAt = nowS();
    const session = await this.issue({
      sub: user.username,
      uid: user.id,
      name: user.display_name,
      role: user.role,
      iat: issuedAt,
      exp: issuedAt + this.config.sessionTtlMinutes * 60,
      idle: issuedAt + this.config.sessionIdleMinutes * 60,
    });
    await this.audit.record(this.db, { actor: user.username, action: 'login', outcome: 'success' });
    return session;
  }

  /**
   * Verifies a session token: HS256 signature, iss, aud, absolute and idle expiry, role.
   * Returns a refreshed token when the idle window should move forward (cookie sessions), unless
   * `slide` is false: background requests (polling, the live stream) must not keep a session alive.
   */
  async verify(
    token: string,
    viaCookie: boolean,
    { slide = true }: { slide?: boolean } = {},
  ): Promise<{ principal: Principal; refreshed?: IssuedSession }> {
    const claims = await this.decode(token);
    const now = nowS();
    if (viaCookie && claims.idle <= now) throw unauthenticated();
    const principal = this.toPrincipal(claims, viaCookie);
    const idleTarget = Math.min(claims.exp, now + this.config.sessionIdleMinutes * 60);
    if (slide && viaCookie && idleTarget - claims.idle >= IDLE_REFRESH_STEP_S) {
      const refreshed = await this.issue({ ...claims, idle: idleTarget });
      return { principal: refreshed.principal, refreshed };
    }
    return { principal };
  }

  /** A new token with the idle window reset (POST /auth/refresh). */
  async refresh(token: string, viaCookie: boolean): Promise<IssuedSession> {
    const claims = await this.decode(token);
    if (viaCookie && claims.idle <= nowS()) throw unauthenticated();
    return this.issue({
      ...claims,
      idle: Math.min(claims.exp, nowS() + this.config.sessionIdleMinutes * 60),
    });
  }

  /** Demo persona switch: only an admin, only in demo mode, for a bounded time. */
  async actAs(
    token: string,
    viaCookie: boolean,
    role: Role | null,
    minutes = 30,
  ): Promise<IssuedSession> {
    const claims = await this.decode(token);
    if (claims.role !== 'admin' || !this.config.demoMode) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Doar administratorul poate schimba rolul, în modul demo.',
      );
    }
    const { act: _act, actExp: _actExp, ...rest } = claims;
    if (role === null || role === 'admin') {
      await this.audit.record(this.db, {
        actor: claims.sub,
        action: 'role_switch',
        outcome: 'success',
        demo: true,
        details: 'admin',
      });
      return this.issue(rest);
    }
    const until = Math.min(claims.exp, nowS() + Math.min(minutes, MAX_ACTING_MINUTES) * 60);
    await this.audit.record(this.db, {
      actor: claims.sub,
      action: 'role_switch',
      outcome: 'success',
      actingAs: role,
      demo: true,
      details: `admin -> ${role}`,
    });
    return this.issue({ ...rest, act: role, actExp: until }, viaCookie);
  }

  me(principal: Principal): MeResponse {
    const realUser: UserRef = {
      id: principal.id,
      username: principal.username,
      displayName: principal.displayName,
      role: principal.role,
    };
    const roles: readonly Role[] =
      principal.role === 'admin' && this.config.demoMode ? ROLES : [principal.role];
    return {
      user: { ...realUser, role: principal.activeRole },
      realUser,
      activeRole: principal.activeRole,
      roles,
      capabilities: capabilitiesOf(principal.activeRole),
      demoMode: this.config.demoMode,
      actingRoleExpiresAt: principal.actingRoleExpiresAt?.toISOString() ?? null,
      expiresAt: principal.expiresAt.toISOString(),
      idleExpiresAt: principal.idleExpiresAt.toISOString(),
      serverTime: new Date().toISOString(),
    };
  }

  private async issue(
    claims: Omit<SessionClaims, 'iat' | 'exp'> & { iat: number; exp: number },
    viaCookie = true,
  ): Promise<IssuedSession> {
    const { iat: _iat, exp, ...payload } = claims;
    const now = nowS();
    const token = await this.jwt.signAsync(
      { ...payload },
      {
        secret: this.config.jwtSecret,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: Math.max(1, exp - now),
      },
    );
    const full: SessionClaims = { ...claims, iat: now, exp };
    return { token, principal: this.toPrincipal(full, viaCookie), maxAgeS: exp - now };
  }

  private async decode(token: string): Promise<SessionClaims> {
    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw unauthenticated();
    }
    const { sub, uid, name, role, act, actExp, idle, iat, exp } = claims;
    const valid =
      typeof sub === 'string' &&
      typeof uid === 'string' &&
      typeof name === 'string' &&
      typeof role === 'string' &&
      ROLE_SET.has(role) &&
      typeof idle === 'number' &&
      typeof iat === 'number' &&
      typeof exp === 'number' &&
      (act === undefined ||
        (typeof act === 'string' && ROLE_SET.has(act) && typeof actExp === 'number'));
    if (!valid) throw unauthenticated();
    return {
      sub,
      uid,
      name,
      role: role as Role,
      ...(act === undefined ? {} : { act: act as Role, actExp: actExp as number }),
      idle,
      iat,
      exp,
    };
  }

  private toPrincipal(claims: SessionClaims, viaCookie: boolean): Principal {
    const acting = claims.act !== undefined && (claims.actExp ?? 0) > nowS();
    return {
      id: claims.uid,
      username: claims.sub,
      displayName: claims.name,
      role: claims.role,
      activeRole: acting && claims.act ? claims.act : claims.role,
      actingRoleExpiresAt: acting && claims.actExp ? new Date(claims.actExp * 1000) : null,
      expiresAt: new Date(claims.exp * 1000),
      idleExpiresAt: new Date((viaCookie ? claims.idle : claims.exp) * 1000),
      viaCookie,
    };
  }

  private async authenticate(username: string, password: string) {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'password_hash', 'role'])
      .where('username', '=', username)
      .executeTakeFirst();
    const valid = await verifyPassword(
      user?.password_hash ?? (await this.timingEqualiser),
      password,
    );
    return user && valid ? user : null;
  }
}

export { iso as epochToIso };
