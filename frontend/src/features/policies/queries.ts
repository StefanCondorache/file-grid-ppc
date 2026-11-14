'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/api/query-keys';
import { policyApi } from './api';
import type { PolicyCategory, PolicyDoc, PolicyUpdate } from './types';

// Under qk.policies.all, so the live bridge's `policy.updated` invalidation refreshes every policy query.
const keys = {
  list: [...qk.policies.all, 'list'] as const,
  one: (c: PolicyCategory) => [...qk.policies.all, 'one', c] as const,
  versions: (c: PolicyCategory) => [...qk.policies.all, 'versions', c] as const,
};

export function usePolicies() {
  return useQuery({ queryKey: keys.list, queryFn: policyApi.list });
}

export function usePolicy(category: PolicyCategory) {
  return useQuery({ queryKey: keys.one(category), queryFn: () => policyApi.get(category) });
}

export function usePolicyVersions(category: PolicyCategory) {
  return useQuery({ queryKey: keys.versions(category), queryFn: () => policyApi.versions(category) });
}

export function useSavePolicy(category: PolicyCategory) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (update: PolicyUpdate) => policyApi.save(category, update),
    onSuccess: (saved: PolicyDoc) => {
      client.setQueryData(keys.one(category), saved);
      void client.invalidateQueries({ queryKey: qk.policies.all });
    },
  });
}
