import {
  type ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import type { Capability } from '../common/domain';
import { unauthenticated } from './auth.service';
import {
  DemoModeGuard,
  MeterKeyGuard,
  NO_SESSION_REFRESH,
  RequireCapabilities,
  SessionGuard,
} from './auth.guards';
import type { AuthRequest, Principal } from './auth.types';

/** Any logged-in user whose active role has every listed capability. */
export const Authenticated = (...capabilities: Capability[]): MethodDecorator & ClassDecorator =>
  applyDecorators(RequireCapabilities(...capabilities), UseGuards(SessionGuard));

/**
 * A background request (polling, the live stream): it needs a valid session but must not slide the
 * idle window, so an open tab does not keep a session alive forever. Only real activity and
 * POST /auth/refresh extend it.
 */
export const NoSessionRefresh = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NO_SESSION_REFRESH, true);

/** Demo-mode only (404 otherwise) and the demo_controls capability (admin). */
export const DemoOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(RequireCapabilities('demo_controls'), UseGuards(DemoModeGuard, SessionGuard));

/** Requests from smart meters with a valid X-API-Key. */
export const MeterAuthenticated = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(MeterKeyGuard));

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthRequest>().principal;
    if (!principal) throw unauthenticated();
    return principal;
  },
);

export const MeterKeyId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  return context.switchToHttp().getRequest<AuthRequest>().meterKeyId ?? 'unknown';
});
