import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AdminGuard, JwtAuthGuard, MeterKeyGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { LoginRateLimiter } from './login-rate-limiter';
import { UserSeeder } from './user-seeder';

/** Import this module wherever routes use @Authenticated(), @AdminOnly() or MeterKeyGuard. */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimiter, UserSeeder, JwtAuthGuard, AdminGuard, MeterKeyGuard],
  exports: [AuthService, JwtAuthGuard, AdminGuard, MeterKeyGuard],
})
export class AuthModule {}
