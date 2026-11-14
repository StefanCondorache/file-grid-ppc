import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './app-error';

export interface ValidationDetail {
  path: string[];
  code: string;
  message: string;
}

/** Validates a request part against a Zod schema; errors list fields, never the input values. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const details: ValidationDetail[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
      message: issue.message,
    }));
    throw new AppError(422, 'validation_error', 'Request validation failed', details);
  }
}
