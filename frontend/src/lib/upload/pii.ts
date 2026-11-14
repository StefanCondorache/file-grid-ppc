import type { PersistedUpload, UploadCategoryId } from './types';

/**
 * Metadata fields that may be written to IndexedDB, per category (ADR-0013, upload-engine.md §8.2).
 * Everything else (applicant name, CNP, address, free text) stays in memory until POST /uploads returns.
 */
const ALLOWED: Record<UploadCategoryId, readonly string[]> = {
  fault_records: ['kind', 'zone', 'substation', 'eventTime', 'severity'],
  drone_videos: ['kind', 'lineSection', 'zone', 'inspectionDate'],
  connection_documents: ['kind', 'requestNumber', 'documentType', 'zone'],
};

/** Categories whose file name may contain personal data ("CI_Popescu_Ion.pdf"). */
const PII_CATEGORIES: readonly UploadCategoryId[] = ['connection_documents'];

export function hasPersonalData(category: UploadCategoryId): boolean {
  return PII_CATEGORIES.includes(category);
}

export function safeMetadata(category: UploadCategoryId, metadata: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED[category]) {
    const value = metadata[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Connection documents never get a persisted file handle (UE-12): they are re-selected after a reload. */
export function persistableHandle<H>(category: UploadCategoryId, handle: H | null | undefined): H | null {
  return hasPersonalData(category) ? null : (handle ?? null);
}

/** The in-memory upload as the engine knows it, before the allow-list is applied. */
export type PersistInput = Omit<PersistedUpload, 'fingerprint' | 'safeMetadata'> & {
  fileName: string;
  nameHash: string;
  size: number;
  lastModified: number;
  type: string;
  metadata: Readonly<Record<string, unknown>>;
};

/** The only way a record reaches IndexedDB: drops PII fields and, for PII categories, the file name. */
export function toPersistable(input: PersistInput, category: UploadCategoryId): PersistedUpload {
  const { fileName, nameHash, size, lastModified, type, metadata, ...rest } = input;
  const fingerprint = hasPersonalData(category)
    ? { nameHash, size, lastModified, type }
    : { nameHash, name: fileName, size, lastModified, type };
  return { ...rest, category, fingerprint, safeMetadata: safeMetadata(category, metadata) };
}
