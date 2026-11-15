/**
 * Wire types of the uploads endpoint group as the NestJS backend implements it (docs/api.md, "Resumable upload";
 * backend/src/uploads). Hand-written because the generated schema.d.ts still follows the OpenAPI proposal, whose
 * category and storage ids differ ("Differences from the frontend proposal"). Shapes, not behaviour.
 */
import type { Role, StorageId, UploadCategoryId } from './types';

export type Zone = 'muntenia' | 'banat' | 'dobrogea';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type DocumentType = 'cerere' | 'act_identitate' | 'aviz';

export interface FaultMetadata {
  kind: 'fault';
  zone: Zone;
  substation: string;
  /** ISO 8601 with offset. */
  eventTime: string;
  severity: Severity;
}

/** Personal data: sent once at create, sealed by the backend, never persisted in the browser. */
export interface ConnectionMetadata {
  kind: 'connection';
  requestNumber: string;
  documentType: DocumentType;
  applicantName: string;
  cnp: string;
  zone?: Zone;
}

export interface DroneMetadata {
  kind: 'drone';
  lineSection: string;
  zone: Zone;
  /** YYYY-MM-DD. */
  inspectionDate: string;
}

export type UploadMetadata = FaultMetadata | ConnectionMetadata | DroneMetadata;

export const METADATA_KIND: Readonly<Record<UploadCategoryId, UploadMetadata['kind']>> = {
  fault_records: 'fault',
  connection_documents: 'connection',
  drone_videos: 'drone',
};

/** POST /uploads body; the `Idempotency-Key` header (8–64 of [A-Za-z0-9-]) is required. */
export interface CreateUploadRequest {
  category: UploadCategoryId;
  fileName: string;
  fileSize: number;
  mimeType: string;
  metadata: UploadMetadata;
}

export type SessionStatus = 'open' | 'verifying' | 'completed' | 'failed' | 'aborted' | 'expired';

/** Inclusive 1-based part ranges, e.g. [[1, 41], [43, 43]]. */
export type PartRanges = [number, number][];

/** 201 (new) or 200 (same key, same file) from POST /uploads. `chunkSize` is authoritative. */
export interface UploadSession {
  uploadId: string;
  status: SessionStatus;
  chunkSize: number;
  partCount: number;
  maxParallel: number;
  policyVersion: number;
  maxFileSize: number;
  expiresAt: string;
  displayName: string;
  receivedRanges: PartRanges;
}

export interface CompleteResult {
  status: 'completed' | 'failed';
  verdict: 'match' | 'mismatch';
  /** null on mismatch: the file is not kept. */
  fileId: string | null;
  clientSha256: string;
  serverSha256: string;
  size: number;
  storage: StorageId;
  usedFallback: boolean;
  policyVersion: number;
  encryptedAtRest: boolean;
  availableAt?: string | null;
  availableAfterMs?: number | null;
  traceId: string;
}

/** GET /uploads/{id}: the resume source of truth. */
export interface UploadStatus {
  uploadId: string;
  status: SessionStatus;
  category?: UploadCategoryId;
  fileSize: number;
  chunkSize: number;
  partCount: number;
  receivedRanges: PartRanges;
  receivedBytes: number;
  policyVersion: number;
  expiresAt: string;
  startedAsRole: Role;
  result: CompleteResult | null;
  error: { code: string; message: string } | null;
}

/** 200 from PUT /uploads/{id}/parts/{n}. */
export interface PartReceipt {
  partNumber: number;
  size: number;
  sha256: string;
  alreadyReceived: boolean;
}

/** GET /policies/{category} (the fields the upload screen reads). */
export interface PolicyView {
  category: UploadCategoryId | 'meter_readings';
  version: number;
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  encryptionLocked: boolean;
  encryptionAlgorithm: string | null;
  chunkSize: number;
  maxParallel: number;
  maxConcurrency: number;
  maxFileSize: number;
  allowedTypes: string[];
  retentionDays: number;
  updatedAt: string;
  updatedBy: { id: string; username: string; displayName: string; role: Role };
}

/** The one error body; extras depend on the code. */
export interface UploadErrorBody {
  code: string;
  message: string;
  traceId: string | null;
  fieldErrors?: { field: string; code: string; message: string }[];
  missingRanges?: PartRanges;
  retryAfterMs?: number;
  storage?: StorageId;
  expectedSize?: number;
  actualSize?: number;
  maxFileSize?: number;
  allowedTypes?: string[];
  status?: SessionStatus;
}

/** Inclusive ranges → part numbers. */
export function rangesToParts(ranges: PartRanges): number[] {
  return ranges.flatMap(([a, b]) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i));
}

/** Part numbers → inclusive ranges ([1, 2, 3, 5] → [[1, 3], [5, 5]]). */
export function partsToRanges(parts: readonly number[]): PartRanges {
  const sorted = [...new Set(parts)].sort((a, b) => a - b);
  const out: PartRanges = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) out[out.length - 1] = [last[0], n];
    else out.push([n, n]);
  }
  return out;
}
