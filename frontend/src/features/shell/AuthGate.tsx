'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { useLogout, useMe, useRefresh } from '@/features/auth/queries';
import { SessionExpiryDialog } from '@/features/auth/SessionExpiryDialog';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { clearClientState } from '@/lib/auth/clear-client-state';
import { scheduleSession, sessionDeadline, WARN_BEFORE_MS } from '@/lib/auth/session';
import { setSessionEndHandler } from '@/lib/auth/session-end';
import { liveHandle } from '@/lib/live/registry';
import { getUploadControl } from '@/lib/upload/engine-port';
import { AppShell } from './AppShell';

const CHANNEL = 'filegrid-session';
type EndKind = 'logout' | 'expired' | 'unauthenticated' | 'remote-logout';

/** The only auth gate (FA-3): loads `me`, ends the session on any 401, warns before expiry, restores uploads. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const client = useQueryClient();
  const refresh = useRefresh();
  const logout = useLogout();
  const [warnDeadline, setWarnDeadline] = useState<number | null>(null);
  const warningRef = useRef(false);
  const endingRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const hereRef = useRef('/');
  useEffect(() => {
    hereRef.current = pathname + (search.toString() ? `?${search.toString()}` : '');
  }, [pathname, search]);

  // Stable across navigations, so the session timers are not rescheduled on every route change.
  const end = useCallback(
    (kind: EndKind) => {
      // Only the first end acts: wiping the cache refetches `me`, whose 401 would otherwise redirect again.
      if (endingRef.current) return;
      endingRef.current = true;
      const reason = kind === 'logout' || kind === 'remote-logout' ? 'logout' : kind === 'expired' ? 'session' : '401';
      const broadcast = kind === 'logout' ? channelRef.current : null;
      // A first visit without a session has nothing to wipe.
      if (kind !== 'unauthenticated') {
        clearClientState({ queryClient: client, closeStream: () => liveHandle.get().close(), uploads: getUploadControl(), broadcast }, reason);
      }
      warningRef.current = false;
      const next = encodeURIComponent(hereRef.current);
      router.replace(kind === 'expired' ? `/login?reason=expired&next=${next}` : kind === 'unauthenticated' ? `/login?next=${next}` : '/login');
    },
    [client, router],
  );

  // Every 401 from any query or mutation lands here (final review #1).
  useEffect(
    () => setSessionEndHandler(() => end(client.getQueryData(qk.me) ? 'expired' : 'unauthenticated')),
    [end, client],
  );

  // First visit without a session: `me` may fail before the handler above is registered.
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401 && !me.data;
  useEffect(() => {
    if (unauthenticated) end('unauthenticated');
  }, [unauthenticated, end]);

  // Other tabs: a logout anywhere wipes this tab too (TM-3, final review #5).
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (m: MessageEvent<{ type?: string }>) => {
      if (m.data?.type === 'logout') end('remote-logout');
    };
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [end]);

  const realUserId = me.data?.realUser.id;
  useEffect(() => {
    if (realUserId) void getUploadControl().restoreAndResume(realUserId);
  }, [realUserId]);

  // Skew is measured against the time `me` was received (final review #3). Before warning or expiring we ask
  // the server again: activity elsewhere may have slid the idle timeout (final review #4).
  const meData = me.data;
  const receivedAt = me.dataUpdatedAt;
  const refetchMe = me.refetch;
  useEffect(() => {
    if (!meData) return;
    return scheduleSession(meData, receivedAt, {
      onWarn: () => {
        if (warningRef.current) return;
        warningRef.current = true;
        void refetchMe().then((r) => {
          if (!r.data) return;
          const deadline = sessionDeadline(r.data, r.dataUpdatedAt);
          if (deadline - Date.now() <= WARN_BEFORE_MS + 1_000) setWarnDeadline(deadline);
          else warningRef.current = false;
        });
      },
      onExpire: () => {
        void refetchMe().then((r) => {
          if (r.data && sessionDeadline(r.data, r.dataUpdatedAt) <= Date.now()) end('expired');
        });
      },
    });
  }, [meData, receivedAt, refetchMe, end]);

  if (me.data) {
    return (
      <>
        <AppShell me={me.data} onLogout={() => void logout.mutateAsync().catch(() => {}).finally(() => end('logout'))}>
          {children}
        </AppShell>
        <SessionExpiryDialog
          open={warnDeadline !== null}
          deadline={warnDeadline ?? 0}
          onStay={() =>
            void refresh.mutateAsync().then(
              () => {
                warningRef.current = false;
                setWarnDeadline(null);
              },
              () => {},
            )
          }
          onLogout={() => void logout.mutateAsync().catch(() => {}).finally(() => end('logout'))}
        />
      </>
    );
  }
  if (me.isError && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <main id="main" className="p-8">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  }
  return <div aria-busy="true" className="min-h-screen animate-pulse bg-page motion-reduce:animate-none" />;
}
