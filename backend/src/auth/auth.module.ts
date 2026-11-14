import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ActingRoleController, AuthController } from './auth.controller';
import { DemoModeGuard, MeterKeyGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { LoginRateLimiter } from './login-rate-limiter';
import { UserSeeder } from './user-seeder';

/** Global: every feature module can use @Authenticated(), @DemoOnly() and @MeterAuthenticated(). */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, ActingRoleController],
  providers: [
    AuthService,
    LoginRateLimiter,
    UserSeeder,
    SessionGuard,
    DemoModeGuard,
    MeterKeyGuard,
  ],
  exports: [AuthService, SessionGuard, DemoModeGuard, MeterKeyGuard],
})
export class AuthModule {}
