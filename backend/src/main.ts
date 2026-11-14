import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG, type AppConfig } from './config/config';
import { BootService } from './lifecycle/boot.service';
import { handleShutdownSignals } from './lifecycle/shutdown';
import { ROOT_LOGGER } from './observability/logger';

/**
 * Listens first (so /healthz answers and /readyz says `starting`), then BootService waits for the
 * database, migrates and seeds; /readyz turns ready when that is done. SIGTERM drains the requests
 * before anything closes (src/lifecycle/shutdown.ts), instead of Nest's enableShutdownHooks().
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(ROOT_LOGGER);
  const stop = handleShutdownSignals(app, { drainTimeoutMs: config.shutdownDrainMs, logger });
  await app.listen(config.port, '0.0.0.0');
  // Bounded by FILEGRID_DB_BOOT_TIMEOUT_S; BootService has logged why.
  app.get(BootService).ready.catch(() => stop(1, 'database not reachable at startup'));
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message: 'startup failed', error: String(error) })}\n`,
  );
  process.exit(1);
});
