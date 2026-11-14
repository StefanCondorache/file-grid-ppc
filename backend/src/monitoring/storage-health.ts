import { STORAGES, type StorageName } from '../common/domain';
import type { StorageStatus } from '../storage/registry';

export interface StorageHealthItem {
  readonly storage: StorageName;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly latencyMs: number | null;
  readonly lastCheckAt: string;
  readonly circuitState: StorageStatus['circuit'];
}

/** This replica's health strip: down when the last probe failed, degraded while the circuit is not closed. */
export function storageHealthItems(
  status: Readonly<Record<StorageName, StorageStatus>>,
): StorageHealthItem[] {
  return STORAGES.map((storage) => {
    const s = status[storage];
    return {
      storage,
      status: s.up === false ? 'down' : s.circuit === 'closed' ? 'ok' : 'degraded',
      latencyMs: s.latencyMs,
      lastCheckAt: s.lastCheckAt ?? new Date().toISOString(),
      circuitState: s.circuit,
    };
  });
}
