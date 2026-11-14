import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { errorBody } from './common/app-error';
import { csrfMiddleware } from './common/csrf.middleware';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { NestPinoLogger, ROOT_LOGGER } from './observability/logger';
import { traceMiddleware } from './observability/trace.middleware';

/** Every API route lives under /api/v1 (ADR-0002); the probes and /metrics stay at the root. */
export const API_PREFIX = 'api/v1';
const ROOT_ROUTES = ['healthz', 'readyz', 'metrics'];

/** Everything main.ts and the tests both need before app.init()/listen(). */
export function configureApp(app: NestExpressApplication): void {
  const logger = app.get<Logger>(ROOT_LOGGER);
  app.useLogger(new NestPinoLogger(logger));
  app.disable('x-powered-by');
  // Behind Traefik in the cluster: trust X-Forwarded-* only from private networks.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(traceMiddleware(logger));
  // With a global prefix Nest's JSON 404 covers only /api/v1/*; answer everything else here.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const path = request.path;
    if (path.startsWith(`/${API_PREFIX}/`) || ROOT_ROUTES.includes(path.slice(1))) return next();
    response.status(404).json(errorBody('NOT_FOUND', 'Resursa nu există.'));
  });
  app.use(csrfMiddleware());
  // After the trace middleware, so a malformed body still gets a trace id. JSON only: upload parts
  // are application/octet-stream and are streamed by their route, never parsed.
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix(API_PREFIX, { exclude: ROOT_ROUTES });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
}
