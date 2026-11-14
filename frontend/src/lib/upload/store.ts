import { create } from 'zustand';
import type { CompleteResult } from './contract';
import type { FailReason, PauseReason, Role, StorageId, UploadCategoryId, UploadState } from './types';

/** Per-part cell state for the chunk grid. */
export const PART_PENDING = 0;
export const PART_IN_FLIGHT = 1;
export const PART_CONFIRMED = 2;
export const PART_RETRYING = 3;

/** The read model of one upload (frontend-architecture §3); written only by the engine. */
export interface UploadItemView {
  id: string;
  ownerUserId: string;
  startedAsRole: Role;
  category: UploadCategoryId;
  /** Display-safe: never personal data for connection documents. */
  displayName: string;
  size: number;
  state: UploadState;
  pauseReason: PauseReason | null;
  failReason: FailReason | null;
  /** Romanian explanation for the current state (failure, pause, storage outage), or null. */
  message: string | null;
  errorCode: string | null;
  traceId: string | null;
  hashedBytes: number;
  bytesConfirmed: number;
  bytesInFlight: number;
  speedBps: number | null;
  etaS: number | null;
  /** Epoch ms of the next automatic retry while `connection_lost`. */
  retryAt: number | null;
  offline: boolean;
  retries: number;
  partCount: number | null;
  /** One cell per part: PART_PENDING | PART_IN_FLIGHT | PART_CONFIRMED | PART_RETRYING. */
  parts: Uint8Array | null;
  policyVersion: number | null;
  primaryStorage: StorageId | null;
  fallbackStorage: StorageId | null;
  encryptionAtRest: boolean;
  chunkSize: number | null;
  maxParallel: number | null;
  clientSha256: string | null;
  result: CompleteResult | null;
  /** The file handle needs a click (requestPermission) before the upload can continue. */
  needsPermission: boolean;
  /** A failed upload that "Reia" can continue (the server still holds its parts). */
  resumable: boolean;
}

export interface UploadStoreState {
  items: Record<string, UploadItemView>;
  /** Enqueue order. */
  order: string[];
}

/** Zustand adapter (ADR-0009): rows select `items[id]`, so a progress tick re-renders only its row. */
export const useUploadStore = create<UploadStoreState>(() => ({ items: {}, order: [] }));

function sameView(a: UploadItemView, b: UploadItemView): boolean {
  for (const k of Object.keys(a) as (keyof UploadItemView)[]) {
    const x = a[k];
    const y = b[k];
    if (x instanceof Uint8Array && y instanceof Uint8Array) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Replaces the store content, keeping the identity of unchanged views. */
export function publishToStore(views: readonly UploadItemView[]): void {
  const prev = useUploadStore.getState().items;
  const items: Record<string, UploadItemView> = {};
  for (const v of views) {
    const old = prev[v.id];
    items[v.id] = old && sameView(old, v) ? old : v;
  }
  useUploadStore.setState({ items, order: views.map((v) => v.id) });
}
