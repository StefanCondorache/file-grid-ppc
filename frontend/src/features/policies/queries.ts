'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { PolicyView } from '@/lib/upload/contract';
import type { PolicyCategory, PolicyUpdate } from './schema';

// The generated schema still has the proposal's ids (fault, S3); the real API speaks fault_records, s3.
type Raw = {
  GET: (path: string, init?: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
  PUT: (path: string, init?: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
};
const raw = api as unknown as Raw;

export type PolicyChange = { field: string; from: string | null; to: string | null };
export type PolicyVersionRow = { version: number; changedAt: string; changedBy: { displayName: string }; changes: PolicyChange[] };

export function usePolicies() {
  return useQuery({
    queryKey: qk.policies.all,
    queryFn: async () => (await unwrap<{ data: PolicyView[] }>(raw.GET('/policies') as never)).data,
  });
}

export function usePolicyHistory(category: PolicyCategory) {
  return useQuery({
    queryKey: qk.policies.history(category as never),
    queryFn: async () =>
      (await unwrap<{ data: PolicyVersionRow[] }>(raw.GET('/policies/{category}/versions', { params: { path: { category } } }) as never)).data,
  });
}

export function useSavePolicy(category: PolicyCategory) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PolicyUpdate) =>
      unwrap<PolicyView>(raw.PUT('/policies/{category}', { params: { path: { category } }, body }) as never),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.policies.all });
    },
  });
}
