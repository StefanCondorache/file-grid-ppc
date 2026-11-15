'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { CircuitState, StorageHealth, StorageId, StorageStatus } from '@/lib/monitoring/contract';

/** Strip order (FE-08): Postgres · S3 · FTP. */
export const STRIP_ORDER: readonly StorageId[] = ['db', 's3', 'ftp'];

const STATUSES: readonly StorageStatus[] = ['ok', 'degraded', 'down'];
const CIRCUITS: readonly CircuitState[] = ['closed', 'half_open', 'open'];

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The real ids (`s3`, `ftp`, `db`) and the proposal's labels (`S3`, `DB`). */
function toStorageId(raw: unknown): StorageId | null {
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  return STRIP_ORDER.find((s) => s === id) ?? null;
}

/**
 * Validates `GET /storage-health` `{ data }` (and the `storage.health` snapshot the live bridge writes to the same key):
 * never trust external data. Unknown storages or statuses are dropped; the result is in strip order.
 */
export function toStorageHealth(raw: unknown): StorageHealth[] {
  const items: unknown[] = isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  const byStorage = new Map<StorageId, StorageHealth>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const storage = toStorageId(item.storage);
    const status = STATUSES.find((s) => s === item.status);
    if (!storage || !status) continue;
    byStorage.set(storage, {
      storage,
      status,
      latencyMs: typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs) ? item.latencyMs : null,
      lastCheckAt: typeof item.lastCheckAt === 'string' ? item.lastCheckAt : '',
      circuitState: CIRCUITS.find((c) => c === item.circuitState) ?? 'closed',
    });
  }
  return STRIP_ORDER.flatMap((s) => byStorage.get(s) ?? []);
}

/** Storage health from the backend's monitor; the live stream (or the polling fallback) keeps the same key fresh. */
export function useStorageHealth() {
  return useQuery({ queryKey: qk.health, queryFn: () => unwrap(api.GET('/storage-health')), select: toStorageHealth });
}
