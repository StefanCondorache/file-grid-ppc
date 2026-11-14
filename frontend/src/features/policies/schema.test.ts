import { describe, expect, it } from 'vitest';
import type { PolicyView } from '@/lib/upload/contract';
import { diffPolicy } from './diff';
import { draftFromPolicy, FALLBACK_SAME, toUpdate, validateDraft } from './schema';

const policy: PolicyView = {
  category: 'fault_records', version: 3, primaryStorage: 's3', fallbackStorage: 'db', encryptionAtRest: false, encryptionLocked: false,
  encryptionAlgorithm: null, chunkSize: 5 * 1024 * 1024, maxParallel: 3, maxConcurrency: 8, maxFileSize: 1000, allowedTypes: [], retentionDays: 30,
  updatedAt: '2026-01-01T00:00:00Z', updatedBy: { id: 'u', username: 'admin', displayName: 'Administrator', role: 'admin' },
};

describe('policy schema and diff', () => {
  it('rejects a fallback equal to the primary', () => {
    const d = { ...draftFromPolicy(policy), fallbackStorage: 's3' as const };
    expect(validateDraft('fault_records', d).fallbackStorage).toBe(FALLBACK_SAME);
  });
  it('rejects 40 MiB chunks and accepts the seed', () => {
    expect(validateDraft('fault_records', { ...draftFromPolicy(policy), chunkMiB: 40 }).chunkMiB).toBeDefined();
    expect(validateDraft('fault_records', draftFromPolicy(policy))).toEqual({});
  });
  it('keeps connection documents encrypted', () => {
    expect(validateDraft('connection_documents', { ...draftFromPolicy(policy), encryptionAtRest: false }).encryptionAtRest).toBeDefined();
  });
  it('lists only changed fields', () => {
    const d = { ...draftFromPolicy(policy), chunkMiB: 8, primaryStorage: 'ftp' as const };
    expect(diffPolicy(policy, toUpdate(policy, d)).map((r) => r.field)).toEqual(['Storage principal', 'Dimensiunea părții']);
  });
});
