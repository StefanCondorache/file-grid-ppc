import { z } from 'zod';
import { UPLOAD_CATEGORIES } from '@/lib/upload/types';

/** Mirrors backend/src/uploads/upload.schemas.ts so mock mode rejects exactly what the real API rejects. */
const ZONES = ['muntenia', 'banat', 'dobrogea'] as const;

const faultMetadata = z.object({
  kind: z.literal('fault'),
  zone: z.enum(ZONES),
  substation: z.string().trim().min(1).max(120),
  eventTime: z.iso.datetime({ offset: true }),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
});

const connectionMetadata = z.object({
  kind: z.literal('connection'),
  requestNumber: z.string().trim().min(1).max(40),
  documentType: z.enum(['cerere', 'act_identitate', 'aviz']),
  applicantName: z.string().trim().min(1).max(200),
  cnp: z.string().regex(/^[1-9][0-9]{12}$/, 'CNP-ul are 13 cifre'),
  zone: z.enum(ZONES).optional(),
});

const droneMetadata = z.object({
  kind: z.literal('drone'),
  lineSection: z.string().trim().min(1).max(120),
  zone: z.enum(ZONES),
  inspectionDate: z.iso.date(),
});

export const createUploadSchema = z.object({
  category: z.enum(UPLOAD_CATEGORIES),
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().min(1),
  mimeType: z.string().trim().min(1).max(255),
  lastModified: z.number().int().nullable().optional(),
  requestedChunkSize: z.number().int().nullable().optional(),
  metadata: z.discriminatedUnion('kind', [faultMetadata, connectionMetadata, droneMetadata]),
});
export type MockCreate = z.infer<typeof createUploadSchema>;

export const completeSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), partCount: z.number().int().min(1) });

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/;

export function fieldErrors(error: z.ZodError): { field: string; code: string; message: string }[] {
  return error.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message }));
}

/** backend/src/files/pii.ts masking: "Ion Popescu" → "I*** P***", CNP → "1*********019". */
export function maskName(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map((p) => `${[...p][0] ?? ''}***`).join(' ');
}

export function maskCnp(cnp: string): string {
  return cnp.length < 4 ? '*'.repeat(cnp.length) : `${cnp[0]}${'*'.repeat(cnp.length - 4)}${cnp.slice(-3)}`;
}
