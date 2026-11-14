import { z } from 'zod';
import { ZONES } from '../common/domain';

export const MAX_BATCH = 500;

export const readingSchema = z.object({
  readingId: z.string().regex(/^[A-Za-z0-9:._-]{1,80}$/),
  meterId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  zone: z.enum(ZONES),
  readingTime: z.iso.datetime({ offset: true }),
  kwh: z.number().min(0).max(1_000_000),
  sequence: z.number().int().min(0),
  origin: z.enum(['simulator', 'storm', 'seed']).default('simulator'),
});
export type Reading = z.infer<typeof readingSchema>;

export const batchSchema = z.object({ readings: z.array(readingSchema).min(1).max(MAX_BATCH) });
export type ReadingBatch = z.infer<typeof batchSchema>;

export const readingQuerySchema = z.object({
  zone: z.enum(ZONES).optional(),
  meterId: z.string().max(64).optional(),
  origin: z.enum(['simulator', 'storm', 'seed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReadingQuery = z.infer<typeof readingQuerySchema>;
