'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import type { Me, Role } from '@/lib/api/types';

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => unwrap(api.GET('/auth/me')), staleTime: 60_000, retry: false });
}

/** Whether the login form asks for a password (temporary demo switch on the backend). Public, cached 5 s. */
export function useLoginOptions() {
  return useQuery({
    queryKey: qk.loginOptions,
    queryFn: () => unwrap(api.GET('/auth/login-options')),
    staleTime: 5_000,
    // The form waits for this answer, so fail fast: one quick retry, then the usual password form.
    retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: 300,
  });
}

/** Without `password` the body is `{username}` only (passwordless demo login). */
export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: Role; password?: string }) =>
      unwrap(api.POST('/auth/login', { body: v.password === undefined ? { username: v.role } : { username: v.role, password: v.password } })),
    onSuccess: (me: Me) => client.setQueryData(qk.me, me),
    // A refused passwordless submit usually means the demo switch was turned off after the page loaded:
    // read the options again so the password field comes back without a reload.
    onError: (error, v) => {
      if (v.password !== undefined || !(error instanceof ApiError)) return;
      if (error.code === 'VALIDATION_ERROR' || error.code === 'INVALID_CREDENTIALS') {
        void client.invalidateQueries({ queryKey: qk.loginOptions });
      }
    },
  });
}

export function useRefresh() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/auth/refresh')),
    onSuccess: (me: Me) => client.setQueryData(qk.me, me),
  });
}

export function useLogout() {
  return useMutation({ mutationFn: () => unwrap(api.POST('/auth/logout')) });
}
