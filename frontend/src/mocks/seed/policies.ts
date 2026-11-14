import type { PolicyCategory, PolicyChange, PolicyVersionEntry } from '@/features/policies/types';

/**
 * Version history behind the policies in db.ts (fault v3, drone v3, connection v2, meter v1). Entries store the
 * changes only; `policy` is null for seeded versions (the UI history reads version, author, date and changes).
 */
const ADMIN = { id: 'u-admin', username: 'admin', displayName: 'Administrator', role: 'admin' };
const MiB = 1024 * 1024;
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

export type PolicyVersionRow = PolicyVersionEntry & { category: PolicyCategory } & Record<string, unknown>;
const entry = (category: PolicyCategory, version: number, age: number, changes: PolicyChange[]): PolicyVersionRow => ({
  category, version, policy: null, changedAt: daysAgo(age), changedBy: ADMIN, changes,
});

export function seedPolicyVersions(): PolicyVersionRow[] {
  return [
    entry('fault_records', 1, 30, []),
    entry('fault_records', 2, 20, [{ field: 'maxParallel', from: '4', to: '2' }]),
    entry('fault_records', 3, 10, [{ field: 'fallbackStorage', from: 'db', to: 'ftp' }]),
    entry('drone_videos', 1, 30, []),
    entry('drone_videos', 2, 21, [{ field: 'chunkSize', from: String(16 * MiB), to: String(8 * MiB) }]),
    entry('drone_videos', 3, 12, [{ field: 'primaryStorage', from: 'ftp', to: 's3' }]),
    entry('connection_documents', 1, 30, []),
    entry('connection_documents', 2, 25, [{ field: 'encryptionAtRest', from: 'false', to: 'true' }]),
    entry('meter_readings', 1, 30, []),
  ];
}
