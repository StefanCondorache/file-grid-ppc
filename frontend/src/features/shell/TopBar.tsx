'use client';

import { LogOut } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { StorageHealthStrip } from '@/features/health/StorageHealthStrip';
import type { Me } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { LivePauseSwitch } from './LivePauseSwitch';
import { LiveStatusPill } from './LiveStatusPill';
import { titleFor } from './nav';
import { RoleSlot } from './RoleSlot';

export function TopBar({ me, onLogout }: { me: Me; onLogout?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-4 glass border-b px-8">
      <h1 className="text-[22px] font-bold tracking-tight">{titleFor(pathname)}</h1>
      <span className="flex-1" />
      <StorageHealthStrip />
      <LiveStatusPill />
      <LivePauseSwitch />
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
