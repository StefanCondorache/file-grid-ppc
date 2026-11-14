'use client';

import { roleLabel } from '@/features/auth/roles';
import { RoleSwitcher } from '@/features/auth/RoleSwitcher';
import type { Me } from '@/lib/api/types';
import { useT } from '@/lib/i18n';

/** Demo mode + real admin → the role switcher; otherwise a static role pill (FE-14: nothing demo-only when off). */
export function RoleSlot({ me }: { me: Me }) {
  const t = useT();
  if (me.demoMode && me.realUser.role === 'admin') return <RoleSwitcher me={me} />;
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-surface px-3.5 text-sm font-semibold">
      {t.auth.activeRole(roleLabel(me.activeRole))}
    </span>
  );
}
