import { z } from 'zod';
import type { PolicyView } from '@/lib/upload/contract';
import type { StorageId } from '@/lib/upload/types';

export const MIB = 1024 * 1024;
export const STORAGE_IDS = ['s3', 'ftp', 'db'] as const;
export type PolicyCategory = PolicyView['category'];
export const POLICY_CATEGORIES: PolicyCategory[] = ['meter_readings', 'fault_records', 'connection_documents', 'drone_videos'];

/** The editable part of a policy, as the form holds it (chunk size in MiB). */
export interface PolicyDraft {
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  chunkMiB: number;
  maxParallel: number;
  maxConcurrency: number;
}

/** PUT /policies/{category} body (docs/api.md). */
export interface PolicyUpdate {
  baseVersion: number;
  primaryStorage: StorageId;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  chunkSize: number;
  maxParallel: number;
  maxConcurrency: number;
  maxFileSize: number;
  allowedTypes: string[];
  retentionDays: number;
}

export const FALLBACK_SAME = 'Rezerva trebuie să fie diferită de storage-ul principal.';

/** Real limits: part size 1–32 MiB, parallel 1–6, bulkhead 1–256; fallback differs from primary; connection stays encrypted. */
export function policySchema(category: PolicyCategory) {
  return z
    .object({
      primaryStorage: z.enum(STORAGE_IDS),
      fallbackStorage: z.enum(STORAGE_IDS).nullable(),
      encryptionAtRest: z.boolean(),
      chunkMiB: z.number({ error: 'Introdu un număr.' }).int('Introdu un număr întreg.').min(1, 'Minimum 1 MiB.').max(32, 'Maximum 32 MiB.'),
      maxParallel: z.number({ error: 'Introdu un număr.' }).int('Introdu un număr întreg.').min(1, 'Minimum 1.').max(6, 'Maximum 6.'),
      maxConcurrency: z.number({ error: 'Introdu un număr.' }).int('Introdu un număr întreg.').min(1, 'Minimum 1.').max(256, 'Maximum 256.'),
    })
    .superRefine((v, ctx) => {
      if (v.fallbackStorage !== null && v.fallbackStorage === v.primaryStorage) {
        ctx.addIssue({ code: 'custom', path: ['fallbackStorage'], message: FALLBACK_SAME });
      }
      if (category === 'connection_documents' && !v.encryptionAtRest) {
        ctx.addIssue({ code: 'custom', path: ['encryptionAtRest'], message: 'Documentele de racordare rămân criptate.' });
      }
    });
}

export function draftFromPolicy(p: PolicyView): PolicyDraft {
  return {
    primaryStorage: p.primaryStorage,
    fallbackStorage: p.fallbackStorage,
    encryptionAtRest: p.encryptionAtRest,
    chunkMiB: Math.round(p.chunkSize / MIB),
    maxParallel: p.maxParallel,
    maxConcurrency: p.maxConcurrency,
  };
}

export function toUpdate(p: PolicyView, d: PolicyDraft): PolicyUpdate {
  return {
    baseVersion: p.version,
    primaryStorage: d.primaryStorage,
    fallbackStorage: d.fallbackStorage,
    encryptionAtRest: d.encryptionAtRest,
    chunkSize: d.chunkMiB * MIB,
    maxParallel: d.maxParallel,
    maxConcurrency: d.maxConcurrency,
    maxFileSize: p.maxFileSize,
    allowedTypes: p.allowedTypes,
    retentionDays: p.retentionDays,
  };
}

/** Errors by field name ("" key never used); empty object when valid. */
export function validateDraft(category: PolicyCategory, d: PolicyDraft): Record<string, string> {
  const r = policySchema(category).safeParse(d);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const issue of r.error.issues) out[String(issue.path[0])] ??= issue.message;
  return out;
}
