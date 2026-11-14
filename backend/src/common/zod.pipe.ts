import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError, type FieldError } from './app-error';

/** Validates a request part against a Zod schema; errors list fields, never the input values. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new AppError(422, 'VALIDATION_ERROR', 'Datele trimise nu sunt valide.', { fieldErrors });
  }
}

/** Validates and returns, for places outside the pipe system (query strings built by hand). */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  return new ZodPipe(schema).transform(value);
}
