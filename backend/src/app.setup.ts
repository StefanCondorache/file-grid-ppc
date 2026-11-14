import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { APP_CONFIG, type AppConfig } from './config/config';
import { NestPinoLogger, ROOT_LOGGER } from './observability/logger';
import { traceMiddleware } from './observability/trace.middleware';

export const EXPOSED_HEADERS = [
  'X-Trace-Id',
  'X-Content-SHA256',
  'Retry-After',
  'Content-Disposition',
];

/** Everything main.ts and the tests both need before app.init()/listen(). */
export function configureApp(app: NestExpressApplication): void {
  const logger = app.get<Logger>(ROOT_LOGGER);
  const config = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(new NestPinoLogger(logger));
  app.disable('x-powered-by');
  // Behind Traefik in the cluster: trust X-Forwarded-For only from private networks.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(traceMiddleware(logger));
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  if (config.corsOrigins.length > 0) {
    app.enableCors({ origin: [...config.corsOrigins], exposedHeaders: EXPOSED_HEADERS });
  }
}
