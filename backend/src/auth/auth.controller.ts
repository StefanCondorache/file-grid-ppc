import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { clientIpOf } from '../common/client-ip';
import { ROLES } from '../common/domain';
import { ZodPipe, parseOrThrow } from '../common/zod.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import { Authenticated, CurrentPrincipal, NoSessionRefresh } from './auth.decorators';
import { DemoModeGuard, SessionGuard, sessionToken } from './auth.guards';
import {
  AuthService,
  type IssuedSession,
  type LoginOptions,
  unauthenticated,
} from './auth.service';
import type { AuthRequest, MeResponse, Principal } from './auth.types';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});
/** Passwordless login (demo only, FILEGRID_PASSWORDLESS_LOGIN): a password may be sent but is ignored. */
const passwordlessLoginSchema = loginSchema.extend({
  password: z.string().max(200).optional(),
});
type LoginBody = z.infer<typeof passwordlessLoginSchema>;

const actingRoleSchema = z.object({
  role: z.enum(ROLES),
  minutes: z.number().int().min(1).max(120).optional(),
});
type ActingRoleBody = z.infer<typeof actingRoleSchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Public: tells the login page whether to ask for a password. */
  @Get('login-options')
  @Header('Cache-Control', 'public, max-age=5')
  loginOptions(): LoginOptions {
    return this.auth.loginOptions();
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() rawBody: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const schema = this.config.passwordlessLogin ? passwordlessLoginSchema : loginSchema;
    const body: LoginBody = parseOrThrow(schema, rawBody);
    const clientIp = clientIpOf(request) ?? 'unknown';
    const session = await this.auth.login(body.username, body.password, clientIp);
    return this.respond(response, session);
  }

  @Post('logout')
  @HttpCode(204)
  @Authenticated()
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    clearSessionCookie(response, this.config);
    await this.audit.record(this.db, {
      actor: principal.username,
      action: 'logout',
      outcome: 'success',
    });
  }

  @Get('me')
  @Authenticated()
  @NoSessionRefresh()
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return this.auth.me(principal);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const presented = sessionToken(request, this.config);
    if (!presented) throw unauthenticated();
    return this.respond(response, await this.auth.refresh(presented.token, presented.viaCookie));
  }

  private respond(response: Response, session: IssuedSession): MeResponse {
    setSessionCookie(response, this.config, session.token, session.maxAgeS);
    return this.auth.me(session.principal);
  }
}

/** The demo role switcher (ADR-0015): an admin acts as another role, server-side, for a while. */
@Controller('demo/acting-role')
// No capability check: an admin acting as another role must still be able to switch back;
// AuthService.actAs checks the real role.
@UseGuards(DemoModeGuard, SessionGuard)
export class ActingRoleController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async switch(
    @Body(new ZodPipe(actingRoleSchema)) body: ActingRoleBody,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    return this.apply(request, response, body.role, body.minutes);
  }

  @Delete()
  @HttpCode(200)
  async clear(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    return this.apply(request, response, null);
  }

  private async apply(
    request: AuthRequest,
    response: Response,
    role: (typeof ROLES)[number] | null,
    minutes?: number,
  ): Promise<MeResponse> {
    const presented = sessionToken(request, this.config);
    if (!presented) throw unauthenticated();
    const session = await this.auth.actAs(presented.token, presented.viaCookie, role, minutes);
    setSessionCookie(response, this.config, session.token, session.maxAgeS);
    return this.auth.me(session.principal);
  }
}
