import { AsyncResource } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { clientIpOf } from '../common/client-ip';
import { type Trace, isValidTraceId, newTraceId, runWithTrace } from './trace-context';

const TRACE_HEADER = 'X-Trace-Id';
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function logRequest(
  logger: Logger,
  method: string,
  path: string,
  status: number,
  trace: Trace,
  aborted: boolean,
): void {
  if (QUIET_PATHS.has(path)) return;
  logger.info(
    {
      method,
      path,
      status,
      duration_ms: Math.round(trace.elapsedMs() * 100) / 100,
      ...(aborted ? { aborted: true } : {}),
    },
    'request',
  );
}

/**
 * Binds a trace id to the request (the client's X-Trace-Id when valid, else a new one), echoes
 * it in the response and logs the request when it ends. Plain Express middleware, so streamed
 * uploads and downloads pass through untouched.
 */
export function traceMiddleware(logger: Logger): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.headers['x-trace-id'];
    const traceId = isValidTraceId(incoming) ? incoming : newTraceId();
    response.setHeader(TRACE_HEADER, traceId);
    const run = (trace: Trace): void => {
      // Without the query string: search terms may name people.
      const path = request.originalUrl.split('?')[0] ?? request.originalUrl;
      trace.attributes.method = request.method;
      trace.attributes.path = path;
      // AsyncResource.bind keeps the trace current inside the event callbacks.
      response.once(
        'finish',
        AsyncResource.bind(() =>
          logRequest(logger, request.method, path, response.statusCode, trace, false),
        ),
      );
      response.once(
        'close',
        AsyncResource.bind(() => {
          if (!response.writableFinished) {
            logRequest(logger, request.method, path, response.statusCode, trace, true);
          }
        }),
      );
      next();
    };
    runWithTrace(traceId, run, clientIpOf(request));
  };
}
