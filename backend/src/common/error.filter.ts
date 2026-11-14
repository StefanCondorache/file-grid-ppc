import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { AppError, errorBody } from './app-error';

const HTTP_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_error',
  429: 'too_many_requests',
  503: 'service_unavailable',
};

const BODY_PARSER_MESSAGES: Readonly<Record<string, string>> = {
  'entity.parse.failed': 'Malformed JSON body',
  'entity.too.large': 'Request body too large',
  'encoding.unsupported': 'Unsupported content encoding',
};

interface DescribedError {
  status: number;
  code: string;
  message: string;
  details: unknown;
  headers: Readonly<Record<string, string>>;
}

function phrase(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

function httpExceptionMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return phrase(exception.getStatus());
}

/** body-parser and other http-errors style failures carry a numeric status and a type. */
function describeHttpLike(error: unknown): DescribedError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  if (status === undefined || status < 400 || status >= 500) return undefined;
  const message =
    typeof candidate.type === 'string' ? BODY_PARSER_MESSAGES[candidate.type] : undefined;
  return {
    status,
    code: HTTP_CODES[status] ?? 'http_error',
    message: message ?? phrase(status),
    details: null,
    headers: {},
  };
}

export function describeError(exception: unknown): DescribedError {
  if (exception instanceof AppError) {
    const { status, code, message, details, headers } = exception;
    return { status, code, message, details, headers };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      code: HTTP_CODES[status] ?? 'http_error',
      message: httpExceptionMessage(exception),
      details: null,
      headers: {},
    };
  }
  return (
    describeHttpLike(exception) ?? {
      status: 500,
      code: 'internal_error',
      message: 'Internal server error',
      details: null,
      headers: {},
    }
  );
}

/** Every error leaves the API as {"error": {code, message, trace_id, details}}. */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const described = describeError(exception);
    if (described.status >= 500) {
      this.logger.error(exception instanceof Error ? exception : String(exception));
    }
    if (response.headersSent) {
      // A streamed response already started: the only honest signal left is a cut connection.
      response.destroy();
      return;
    }
    response
      .set(described.headers)
      .status(described.status)
      .json(errorBody(described.code, described.message, described.details));
  }
}
