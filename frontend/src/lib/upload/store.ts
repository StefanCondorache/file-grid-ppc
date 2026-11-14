import { create } from 'zustand';
import type { FailReason, PauseReason, Role, StorageId, UploadCategoryId, UploadState } from './types';

export interface UploadErrorView {
  code: string;
  /** Romanian, safe to show. */
  message: string;
  traceId?: string;
  /** The storage named by a 503 STORAGE_UNAVAILABLE (FE-08). */
  storage?: StorageId;
}

/**
 * One row of the tray and the Încărcare queue (frontend-architecture §3). Written only by the upload engine;
 * React reads it with selectors. No personal data: connection documents show the server's display name.
 */
export interface UploadItemView {
  id: string;
  displayName: string;
  category: UploadCategoryId;
  size: number;
  /** Bytes of server-confirmed parts. */
  bytesConfirmed: number;
  /** Partial bytes of parts being sent; progress = (bytesConfirmed + bytesInFlight) / size. */
  bytesInFlight: number;
  /** Progress of the hash-first pass, while `state` is `hashing`. */
  hashedBytes: number;
  /** Null for the first 3 s of data and outside `uploading`. */
  speedBps: number | null;
  etaS: number | null;
  state: UploadState;
  pausedReason?: PauseReason;
  failReason?: FailReason;
  /** Epoch ms of the next retry while `connection_lost` with a countdown; the UI ticks it, the engine does not. */
  retryAt?: number;
  /** Seconds to `retryAt` when this snapshot was taken. */
  retryInS?: number;
  /** `connection_lost` because the device is offline: no countdown, "reluăm automat". */
  offline: boolean;
  clientSha256?: string;
  serverSha256?: string;
  verdict?: 'match' | 'mismatch';
  /** Null on a mismatch: the file was not kept. */
  fileId?: string | null;
  traceId?: string;
  error?: UploadErrorView;
  /** Null for the first moments of a new upload, until the engine has asked who started it. */
  startedAsRole: Role | null;
  ownerUserId: string;
  availableAfterMs?: number | null;
  /** Chunk grid: null until the server fixed the part size. */
  partCount: number | null;
  /** Bitset of confirmed parts, bit n-1 = part n (repo.ts helpers). */
  confirmed: Uint8Array;
  inFlightParts: number[];
  /** Parts waiting for a retry after a failure. */
  retryingParts: number[];
  storage?: StorageId;
  usedFallback?: boolean;
  /** The policy version frozen when the upload started ("Politica v3 (la pornire)"). */
  policyVersion?: number;
  /**
   * `needs_file` with a stored file handle (Chromium) that only needs read access again: one click on the row gives
   * the file back. When false the user re-selects the file (`reattach`).
   */
  reopenable: boolean;
}

export interface UploadStoreState {
  items: Record<string, UploadItemView>;
}

/** Zustand adapter of the upload engine: `useUploadStore((s) => s.items)`. Only the engine writes to it. */
export const useUploadStore = create<UploadStoreState>()(() => ({ items: {} }));
