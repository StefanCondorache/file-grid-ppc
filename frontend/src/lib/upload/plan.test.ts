import { describe, expect, it } from 'vitest';
import { effectiveMime, formatLimit, isUsableChunkSize, partCount, planParts, validateFile } from './plan';
import type { PolicySnapshot } from './types';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const drone: PolicySnapshot = {
  category: 'drone_videos',
  version: 3,
  primaryStorage: 'ftp',
  fallbackStorage: 's3',
  encryptionAtRest: false,
  chunkSize: 16 * MiB,
  maxParallel: 4,
  maxFileSize: 4 * GiB,
  allowedTypes: ['video/mp4', 'video/quicktime'],
};

describe('server part size guard', () => {
  it('accepts the backend bounds 1–32 MiB and nothing else', () => {
    expect(isUsableChunkSize(5 * MiB)).toBe(true);
    expect(isUsableChunkSize(1 * MiB)).toBe(true);
    expect(isUsableChunkSize(32 * MiB)).toBe(true);
    expect(isUsableChunkSize(64 * MiB)).toBe(false);
    expect(isUsableChunkSize(512 * 1024)).toBe(false);
    expect(isUsableChunkSize(0)).toBe(false);
    expect(isUsableChunkSize(5.5 * MiB + 0.5)).toBe(false);
  });
});

describe('part plan', () => {
  it('numbers parts from 1 and makes the last one shorter', () => {
    const parts = planParts(12 * MiB, 5 * MiB);
    expect(parts).toEqual([
      { n: 1, start: 0, end: 5 * MiB },
      { n: 2, start: 5 * MiB, end: 10 * MiB },
      { n: 3, start: 10 * MiB, end: 12 * MiB },
    ]);
    expect(partCount(12 * MiB, 5 * MiB)).toBe(3);
  });

  it('has one part for a file smaller than a part and exact parts on a boundary', () => {
    expect(planParts(10, 5 * MiB)).toEqual([{ n: 1, start: 0, end: 10 }]);
    expect(partCount(10 * MiB, 5 * MiB)).toBe(2);
  });
});

describe('policy pre-validation (Review Focus 5)', () => {
  it('rejects an empty file with only that reason', () => {
    expect(validateFile({ size: 0, type: 'video/mp4', name: 'a.mp4' }, drone)).toEqual(['Fișierul este gol.']);
  });

  it('rejects a file over the policy maximum', () => {
    expect(validateFile({ size: 4 * GiB + 1, type: 'video/mp4', name: 'a.mp4' }, drone)).toEqual(['Fișierul depășește 4\u00A0GB, limita politicii.']);
  });

  it('rejects a type the policy does not allow', () => {
    expect(validateFile({ size: 10, type: 'video/avi', name: 'a.avi' }, drone)).toEqual(['Tipul video/avi nu este permis pentru această categorie.']);
  });

  it('accepts a valid file and any type when the policy lists none', () => {
    expect(validateFile({ size: 10, type: 'video/mp4', name: 'a.mp4' }, drone)).toEqual([]);
    expect(validateFile({ size: 10, type: 'text/x-odd', name: 'a' }, { ...drone, allowedTypes: [] })).toEqual([]);
  });

  it('treats an unknown browser type as application/octet-stream, like the create request', () => {
    expect(effectiveMime({ type: '' })).toBe('application/octet-stream');
    expect(validateFile({ size: 10, type: '', name: 'x.bin' }, { ...drone, allowedTypes: ['application/octet-stream'] })).toEqual([]);
  });

  it('formats limits without trailing zeros', () => {
    expect(formatLimit(4 * GiB)).toBe('4 GB');
    expect(formatLimit(512 * MiB)).toBe('512 MB');
    expect(formatLimit(1.5 * GiB)).toBe('1,5 GB');
  });
});
