'use client';

import { Info, LogOut } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { MockMarker } from '@/components/MockMarker';
import { Button } from '@/components/ui/button';
import { StorageHealthStrip } from '@/features/health/StorageHealthStrip';
import type { Me } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { LivePauseSwitch } from './LivePauseSwitch';
import { titleFor } from './nav';
import { RoleSlot } from './RoleSlot';

export function TopBar({ me, onLogout }: { me: Me; onLogout?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-border bg-surface px-8">
      <h1 className="text-[22px] font-bold tracking-tight">{titleFor(pathname)}</h1>
      <span className="flex-1" />
      <StorageHealthStrip />
      <LivePauseSwitch />
      {me.demoMode && (
        <span className="hidden h-[30px] items-center gap-1.5 rounded-chip border-[1.5px] border-info px-2.5 text-xs font-bold tracking-wide text-info-ink uppercase md:inline-flex">
          <Info aria-hidden="true" className="size-4" />
          {t.shell.envDemo}
        </span>
      )}
      <MockMarker />
      <RoleSlot me={me} />
      <span className="sr-only">{t.shell.user(me.realUser.displayName)}</span>
      {onLogout && (
        <Button variant="quiet" size="sm" onClick={onLogout} aria-label={t.auth.logout} title={t.auth.logout}>
          <LogOut aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}
