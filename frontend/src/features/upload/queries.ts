'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { toPolicySnapshot } from '@/lib/upload/api';
import type { PolicySnapshot, UploadCategoryId } from '@/lib/upload/types';

/** The policy fields the upload screen shows: the engine's snapshot plus the encryption algorithm. */
export interface UploadPolicyView extends PolicySnapshot {
  encryptionAlgorithm: string | null;
}

export type UploadPolicies = Partial<Record<UploadCategoryId, UploadPolicyView>>;

/** Policies of the 3 manual categories from a `GET /policies` body; anything malformed is left out (never trusted). */
export function selectUploadPolicies(raw: unknown): UploadPolicies {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
  const out: UploadPolicies = {};
  for (const item of list) {
    try {
      const snapshot = toPolicySnapshot(item);
      const algorithm = (item as { encryptionAlgorithm?: unknown }).encryptionAlgorithm;
      out[snapshot.category] = { ...snapshot, encryptionAlgorithm: typeof algorithm === 'string' && algorithm ? algorithm : null };
    } catch {
      // meter_readings, or a policy the screen cannot use: the engine re-reads the policy at start anyway.
    }
  }
  return out;
}

/**
 * The live policies (BA-05). The raw body is cached under `qk.policies.all`, the entry the live stream refreshes on
 * `policy.updated` and the policies screen reads too, so a policy edit shows here at once (beat 7).
 */
export function useUploadPolicies() {
  return useQuery({ queryKey: qk.policies.all, queryFn: () => unwrap(api.GET('/policies')), select: selectUploadPolicies, staleTime: 30_000 });
}
