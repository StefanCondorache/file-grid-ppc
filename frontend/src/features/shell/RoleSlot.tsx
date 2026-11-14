'use client';

import { roleLabel } from '@/features/auth/roles';
import type { Me } from '@/lib/api/types';
import { useT } from '@/lib/i18n';

/** Static role pill; Task 6a.7 renders the demo role switcher here when demo mode is on. */
export function RoleSlot({ me }: { me: Me }) {
  const t = useT();
  const acting = me.activeRole !== me.realUser.role;
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-surface px-3.5 text-sm font-semibold">
      {t.auth.activeRole(roleLabel(me.activeRole))}
      {acting && <span className="rounded bg-ppc-blue px-1.5 text-[11px] text-(--fg-on-chrome)">{t.auth.demoRole}</span>}
    </span>
  );
}
