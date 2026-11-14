import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { errorBody } from './common/app-error';
import { csrfMiddleware } from './common/csrf.middleware';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { securityHeaders } from './common/security-headers';
import { APP_CONFIG, type AppConfig } from './config/config';
import { Lifecycle } from './lifecycle/lifecycle';
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
  // First: every request counts as in flight until its response closes (graceful shutdown).
  app.use(app.get(Lifecycle).middleware());
  // Behind Traefik (pod CIDR, externalTrafficPolicy: Local): request.ip is the client from
  // X-Forwarded-For only when the TCP peer is in TRUSTED_PROXY_CIDRS; otherwise the peer itself.
  const { trustedProxyCidrs } = app.get<AppConfig>(APP_CONFIG);
  app.set('trust proxy', trustedProxyCidrs.length > 0 ? [...trustedProxyCidrs] : false);
  app.use(securityHeaders());
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
