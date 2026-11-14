import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError, errorBody } from './app-error';

/** Codes and Romanian messages for errors that do not come from our own AppError. */
const HTTP_ERRORS: Readonly<Record<number, readonly [string, string]>> = {
  400: ['BAD_REQUEST', 'Cererea nu este validă.'],
  401: ['UNAUTHENTICATED', 'Sesiunea lipsește sau a expirat.'],
  403: ['FORBIDDEN', 'Nu aveți dreptul să faceți această acțiune.'],
  404: ['NOT_FOUND', 'Resursa nu există.'],
  405: ['METHOD_NOT_ALLOWED', 'Metoda nu este permisă.'],
  409: ['CONFLICT', 'Cererea intră în conflict cu starea curentă.'],
  413: ['PAYLOAD_TOO_LARGE', 'Corpul cererii este prea mare.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Tipul conținutului nu este acceptat.'],
  422: ['VALIDATION_ERROR', 'Datele trimise nu sunt valide.'],
  429: ['RATE_LIMITED', 'Prea multe cereri. Încercați din nou mai târziu.'],
  503: ['SERVICE_UNAVAILABLE', 'Serviciul este temporar indisponibil.'],
};

const BODY_PARSER_ERRORS: Readonly<Record<string, readonly [string, string]>> = {
  'entity.parse.failed': ['MALFORMED_JSON', 'Corpul cererii nu este JSON valid.'],
  'entity.too.large': ['PAYLOAD_TOO_LARGE', 'Corpul cererii este prea mare.'],
  'encoding.unsupported': ['UNSUPPORTED_ENCODING', 'Codificarea conținutului nu este acceptată.'],
};

interface DescribedError {
  status: number;
  code: string;
  message: string;
  extras: Readonly<Record<string, unknown>>;
  headers: Readonly<Record<string, string>>;
}

function fromStatus(status: number): DescribedError {
  const [code, message] = HTTP_ERRORS[status] ?? ['HTTP_ERROR', 'Cererea nu a reușit.'];
  return { status, code, message, extras: {}, headers: {} };
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
  const known = typeof candidate.type === 'string' ? BODY_PARSER_ERRORS[candidate.type] : undefined;
  return known ? { ...fromStatus(status), code: known[0], message: known[1] } : fromStatus(status);
}

export function describeError(exception: unknown): DescribedError {
  if (exception instanceof AppError) {
    const { status, code, message, extras, headers } = exception;
    return { status, code, message, extras, headers };
  }
  if (exception instanceof HttpException) {
    // Nest's own exceptions (unknown route, wrapped body-parser errors) carry English text: replace it.
    return describeHttpLike(exception.cause) ?? fromStatus(exception.getStatus());
  }
  return (
    describeHttpLike(exception) ?? {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'A apărut o eroare internă. Folosiți ID-ul de urmărire pentru detalii.',
      extras: {},
      headers: {},
    }
  );
}

/** Every error leaves the API as {code, message, traceId, ...extras}; 5xx never leak internals. */
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
      .json(errorBody(described.code, described.message, described.extras));
  }
}
