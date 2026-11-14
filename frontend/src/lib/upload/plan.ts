import { formatBytes } from '@/lib/i18n/format';
import { ro } from '@/lib/i18n/ro';
import type { PolicySnapshot } from './types';

const MiB = 1024 * 1024;
/** The backend's policy bounds (MIN_CHUNK_SIZE..MAX_CHUNK_SIZE); 32 MiB keeps every part under Cloudflare's 100 MB. */
export const MIN_PART_SIZE = 1 * MiB;
export const MAX_PART_SIZE = 32 * MiB;

export interface PartRange {
  n: number;
  start: number;
  end: number;
}

/**
 * The part size comes from the server's `chunkSize` (POST /uploads), never from the client. A value outside the
 * backend's own bounds is a contract violation: refuse it rather than send a part Cloudflare would reject.
 */
export function isUsableChunkSize(chunkSize: number): boolean {
  return Number.isInteger(chunkSize) && chunkSize >= MIN_PART_SIZE && chunkSize <= MAX_PART_SIZE;
}

export function partCount(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize);
}

/** 1-based part ranges [start, end); the last part is shorter. Used for slicing at send time. */
export function planParts(size: number, chunkSize: number): PartRange[] {
  return Array.from({ length: partCount(size, chunkSize) }, (_, i) => ({
    n: i + 1,
    start: i * chunkSize,
    end: Math.min(size, (i + 1) * chunkSize),
  }));
}

/** Byte range of part `n` (1-based). */
export function partRange(n: number, size: number, chunkSize: number): PartRange {
  return { n, start: (n - 1) * chunkSize, end: Math.min(size, n * chunkSize) };
}

/** Browsers report '' for unknown types; the create request then says application/octet-stream. */
export function effectiveMime(file: { type: string }): string {
  return file.type || 'application/octet-stream';
}

/** "4 GB", "512 MB", "1,5 GB": a policy limit without trailing zero decimals. */
export function formatLimit(bytes: number): string {
  return formatBytes(bytes).replace(/,(\d*?)0+(?= )/, (_, kept: string) => (kept ? `,${kept}` : ''));
}

/** Rejects a file before any request, with Romanian reasons (FE-02, Review Focus 5). */
export function validateFile(file: { size: number; type: string; name: string }, policy: PolicySnapshot): string[] {
  const t = ro.upload.validation;
  if (file.size === 0) return [t.empty];
  const reasons: string[] = [];
  if (file.size > policy.maxFileSize) reasons.push(t.tooLarge(formatLimit(policy.maxFileSize)));
  const mime = effectiveMime(file);
  if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(mime)) reasons.push(t.typeNotAllowed(mime));
  return reasons;
}
