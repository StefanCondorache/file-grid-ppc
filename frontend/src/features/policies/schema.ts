import { z } from 'zod';
import { ro } from '@/lib/i18n/ro';
import { STORAGES, type PolicyCategory, type PolicyDoc, type PolicyUpdate, type StorageId } from './types';

const MiB = 1024 * 1024;
const v = ro.policies.validation;

/** The editable fields; the rest of the policy is carried over unchanged from the base version. */
export type PolicyFormValues = {
  primaryStorage: StorageId;
  fallbackStorage: StorageId | 'none';
  encryptionAtRest: boolean;
  chunkSizeMiB: number;
  maxParallel: number;
};

/** docs/api.md limits: part 1–32 MiB, 1–6 in parallel, fallback ≠ primary; connection documents always encrypted. */
export function policySchema(category: PolicyCategory) {
  return z
    .object({
      primaryStorage: z.enum(STORAGES),
      fallbackStorage: z.enum([...STORAGES, 'none']),
      encryptionAtRest: z.boolean(),
      chunkSizeMiB: z.number({ error: v.chunk }).int(v.chunk).min(1, v.chunk).max(32, v.chunk),
      maxParallel: z.number({ error: v.parallel }).int(v.parallel).min(1, v.parallel).max(6, v.parallel),
    })
    .superRefine((val, ctx) => {
      if (val.fallbackStorage === val.primaryStorage) ctx.addIssue({ code: 'custom', path: ['fallbackStorage'], message: v.fallbackSame });
      if (category === 'connection_documents' && !val.encryptionAtRest) ctx.addIssue({ code: 'custom', path: ['encryptionAtRest'], message: v.encryption });
    });
}

export function toFormValues(p: PolicyDoc): PolicyFormValues {
  return {
    primaryStorage: p.primaryStorage,
    fallbackStorage: p.fallbackStorage ?? 'none',
    encryptionAtRest: p.encryptionAtRest,
    chunkSizeMiB: Math.round(p.chunkSize / MiB),
    maxParallel: p.maxParallel,
  };
}

export function toUpdate(base: PolicyDoc, f: PolicyFormValues): PolicyUpdate {
  return {
    baseVersion: base.version,
    primaryStorage: f.primaryStorage,
    fallbackStorage: f.fallbackStorage === 'none' ? null : f.fallbackStorage,
    encryptionAtRest: f.encryptionAtRest,
    chunkSize: f.chunkSizeMiB * MiB,
    maxParallel: f.maxParallel,
    maxFileSize: base.maxFileSize,
    allowedTypes: base.allowedTypes,
    retentionDays: base.retentionDays,
  };
}
