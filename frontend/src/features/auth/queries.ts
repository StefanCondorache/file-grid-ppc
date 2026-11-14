'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { Me, Role } from '@/lib/api/types';

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => unwrap(api.GET('/auth/me')), staleTime: 60_000, retry: false });
}

/** Whether the login form asks for a password (temporary demo switch on the backend). Public, cached 5 s. */
export function useLoginOptions() {
  return useQuery({ queryKey: qk.loginOptions, queryFn: () => unwrap(api.GET('/auth/login-options')), staleTime: 5_000 });
}

/** Without `password` the body is `{username}` only (passwordless demo login). */
export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: Role; password?: string }) =>
      unwrap(api.POST('/auth/login', { body: v.password === undefined ? { username: v.role } : { username: v.role, password: v.password } })),
    onSuccess: (me: Me) => client.setQueryData(qk.me, me),
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
