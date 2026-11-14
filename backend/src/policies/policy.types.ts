import type { Category, StorageName } from '../common/domain';
import type { UserRef } from '../auth/auth.types';

/** A category's storage policy as the API shows it (docs/api.md, "Policies"). */
export interface PolicyView {
  readonly category: Category;
  readonly version: number;
  readonly primaryStorage: StorageName;
  readonly fallbackStorage: StorageName | null;
  readonly encryptionAtRest: boolean;
  readonly encryptionLocked: boolean;
  readonly encryptionAlgorithm: string | null;
  readonly chunkSize: number;
  readonly maxParallel: number;
  /** Server-side bulkhead: concurrent storage operations allowed for this category. */
  readonly maxConcurrency: number;
  readonly maxFileSize: number;
  readonly allowedTypes: readonly string[];
  readonly retentionDays: number;
  readonly updatedAt: string;
  readonly updatedBy: UserRef;
}

/** What the services need from a policy; read live from the database on every operation. */
export interface Policy {
  readonly category: Category;
  readonly version: number;
  readonly primaryStorage: StorageName;
  readonly fallbackStorage: StorageName | null;
  readonly encrypted: boolean;
  readonly chunkSize: number;
  readonly maxParallel: number;
  readonly maxConcurrency: number;
  readonly maxFileSize: number;
  readonly allowedTypes: readonly string[];
  readonly retentionDays: number;
}
