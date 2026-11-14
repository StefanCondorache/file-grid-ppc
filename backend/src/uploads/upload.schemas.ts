import { z } from 'zod';
import { UPLOAD_CATEGORIES, type UploadCategory, ZONES } from '../common/domain';

/** Upload metadata per category (docs/api.md, "Uploads"); `kind` must match the category. */
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

export const uploadMetadataSchema = z.discriminatedUnion('kind', [
  faultMetadata,
  connectionMetadata,
  droneMetadata,
]);
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;

export const METADATA_KIND: Readonly<Record<UploadCategory, UploadMetadata['kind']>> = {
  fault_records: 'fault',
  connection_documents: 'connection',
  drone_videos: 'drone',
};

export const createUploadSchema = z.object({
  category: z.enum(UPLOAD_CATEGORIES),
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().min(1),
  mimeType: z.string().trim().min(1).max(255),
  lastModified: z.number().int().nullable().optional(),
  requestedChunkSize: z.number().int().nullable().optional(),
  metadata: uploadMetadataSchema,
});
export type CreateUpload = z.infer<typeof createUploadSchema>;

export const completeUploadSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 în hex, litere mici'),
  partCount: z.number().int().min(1),
});
export type CompleteUpload = z.infer<typeof completeUploadSchema>;

export const idempotencyKeySchema = z
  .string({ error: 'Antetul Idempotency-Key este obligatoriu.' })
  .regex(/^[A-Za-z0-9-]{8,64}$/, 'Idempotency-Key: 8-64 caractere (UUID recomandat)');
