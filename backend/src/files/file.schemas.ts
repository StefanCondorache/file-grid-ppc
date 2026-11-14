import { z } from 'zod';
import { CATEGORIES, INTEGRITY_STATES, ORIGINS, ZONES } from '../common/domain';

const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const fileQuerySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  zone: z.enum(ZONES).optional(),
  origin: z.enum(ORIGINS).optional(),
  integrity: z.enum(INTEGRITY_STATES).optional(),
  excludeGenerated: flag.default(false),
  sort: z.enum(['-createdAt', 'createdAt', '-size', 'size']).default('-createdAt'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type FileQuery = z.infer<typeof fileQuerySchema>;

export const revealSchema = z.object({ reason: z.string().trim().min(10).max(500) });
