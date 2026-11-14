import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { Authenticated, CurrentUser } from './auth.decorators';
import { AuthService } from './auth.service';
import type { AuthUser, LoginResult } from './auth.types';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
type LoginBody = z.infer<typeof loginSchema>;

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodPipe(loginSchema)) body: LoginBody,
    @Req() request: Request,
  ): Promise<LoginResult> {
    return this.auth.login(body.username, body.password, request.ip ?? 'unknown');
  }

  @Get('me')
  @Authenticated()
  me(@CurrentUser() user: AuthUser): AuthUser {
    return { username: user.username, role: user.role };
  }
}
