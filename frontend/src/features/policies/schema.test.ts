import { describe, expect, it } from 'vitest';
import { diffPolicy } from './diff';
import { policySchema, toFormValues, toUpdate } from './schema';
import type { PolicyDoc } from './types';

const MiB = 1024 * 1024;
const fault: PolicyDoc = {
  category: 'fault_records', version: 3, primaryStorage: 's3', fallbackStorage: 'ftp', encryptionAtRest: false, encryptionLocked: false,
  encryptionAlgorithm: null, chunkSize: 8 * MiB, maxParallel: 2, maxFileSize: 50 * MiB, allowedTypes: ['application/pdf'], retentionDays: 365,
  updatedAt: '2026-11-14T10:00:00Z', updatedBy: null,
};

const issues = (category: PolicyDoc['category'], v: unknown) => {
  const r = policySchema(category).safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('policySchema', () => {
  it('rejects a fallback equal to the primary', () => {
    expect(issues('fault_records', { ...toFormValues(fault), fallbackStorage: 's3' })).toContain('Rezerva trebuie să fie diferită de storage-ul principal.');
  });

  it('rejects a 40 MiB part and forces encryption for connection documents', () => {
    expect(issues('fault_records', { ...toFormValues(fault), chunkSizeMiB: 40 })).toHaveLength(1);
    expect(issues('connection_documents', { ...toFormValues(fault), encryptionAtRest: false })).toHaveLength(1);
    expect(issues('fault_records', toFormValues(fault))).toEqual([]);
  });
});

describe('diffPolicy', () => {
  it('lists only the changed fields with Romanian labels', () => {
    const next = toUpdate(fault, { ...toFormValues(fault), primaryStorage: 'ftp', fallbackStorage: 's3' });
    expect(next.baseVersion).toBe(3);
    expect(diffPolicy(fault, next)).toEqual([
      { field: 'Storage principal', from: 'S3', to: 'FTP' },
      { field: 'Storage de rezervă', from: 'FTP', to: 'S3' },
    ]);
  });
});
