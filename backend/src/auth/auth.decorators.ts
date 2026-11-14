import {
  type ExecutionContext,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { AppError } from '../common/app-error';
import { AdminGuard, JwtAuthGuard } from './auth.guards';
import type { AuthRequest, AuthUser } from './auth.types';

/** Any logged-in user (admin or operator). */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(JwtAuthGuard));

/** Logged-in admins only. */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(JwtAuthGuard, AdminGuard));

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser => {
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new AppError(401, 'unauthorized', 'Missing bearer token');
    return user;
  },
);

export const MeterKeyId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const keyId = context.switchToHttp().getRequest<AuthRequest>().meterKeyId;
  if (!keyId) throw new AppError(401, 'invalid_api_key', 'Missing or invalid meter API key');
  return keyId;
});
