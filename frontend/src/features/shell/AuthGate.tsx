'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { useLogout, useMe, useRefresh } from '@/features/auth/queries';
import { SessionExpiryDialog } from '@/features/auth/SessionExpiryDialog';
import { ApiError } from '@/lib/api/errors';
import { clearClientState } from '@/lib/auth/clear-client-state';
import { scheduleSession, sessionDeadline } from '@/lib/auth/session';
import { liveHandle } from '@/lib/live/registry';
import { getUploadControl } from '@/lib/upload/engine-port';
import { AppShell } from './AppShell';

function broadcast(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('filegrid-session');
}

/** The only auth gate (FA-3): loads `me`, redirects on 401, schedules the expiry warning, restores uploads. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const client = useQueryClient();
  const refresh = useRefresh();
  const logout = useLogout();
  const [warnDeadline, setWarnDeadline] = useState<number | null>(null);
  const here = pathname + (search.toString() ? `?${search.toString()}` : '');

  const end = useCallback(
    (reason: 'logout' | 'session') => {
      clearClientState({ queryClient: client, closeStream: () => liveHandle.get().close(), uploads: getUploadControl(), broadcast: broadcast() }, reason);
      router.replace(reason === 'session' ? `/login?reason=expired&next=${encodeURIComponent(here)}` : '/login');
    },
    [client, router, here],
  );

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(here)}`);
  }, [unauthenticated, router, here]);

  const realUserId = me.data?.realUser.id;
  useEffect(() => {
    if (realUserId) void getUploadControl().restoreAndResume(realUserId);
  }, [realUserId]);

  useEffect(() => {
    if (!me.data) return;
    const data = me.data;
    return scheduleSession(data, Date.now(), { onWarn: () => setWarnDeadline(sessionDeadline(data, Date.now())), onExpire: () => end('session') });
  }, [me.data, end]);

  if (me.data) {
    return (
      <>
        <AppShell me={me.data} onLogout={() => void logout.mutateAsync().finally(() => end('logout'))}>
          {children}
        </AppShell>
        <SessionExpiryDialog
          open={warnDeadline !== null}
          deadline={warnDeadline ?? 0}
          onStay={() => void refresh.mutateAsync().then(() => setWarnDeadline(null))}
          onLogout={() => void logout.mutateAsync().finally(() => end('logout'))}
        />
      </>
    );
  }
  if (me.isError && !unauthenticated) return <main id="main" className="p-8"><ErrorState error={me.error} onRetry={() => void me.refetch()} /></main>;
  return <div aria-busy="true" className="min-h-screen animate-pulse bg-page motion-reduce:animate-none" />;
}
