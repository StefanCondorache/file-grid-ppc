'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { announce } from '@/lib/a11y/announcer';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { Me, Role } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { liveHandle } from '@/lib/live/registry';
import { ROLE_OPTIONS, roleLabel } from './roles';

type ActingRole = 'teren' | 'dispecerat' | 'racordari' | 'auditor';

/**
 * Demo-only persona switch (ADR-0015/0022): server-side acting role, audited. Uploads keep running (BA-65);
 * every other query is reset and the stream reconnects because the backend filters events by the active role.
 */
export function RoleSwitcher({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const acting = me.activeRole !== me.realUser.role;

  async function switchTo(role: Role) {
    if (role === me.activeRole) return;
    const next = role === me.realUser.role
      ? await unwrap(api.DELETE('/demo/acting-role'))
      : await unwrap(api.POST('/demo/acting-role', { body: { role: role as ActingRole } }));
    qc.setQueryData(qk.me, next);
    await qc.resetQueries({ predicate: (q) => q.queryKey[0] !== qk.me[0] });
    liveHandle.get().reconnect();
    announce(t.auth.activeRole(roleLabel(next.activeRole)));
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="inline-flex h-9 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-surface px-3.5 text-sm font-semibold">
        {t.auth.activeRole(roleLabel(me.activeRole))}
        {acting && <span className="rounded bg-ppc-blue px-1.5 text-[11px] text-(--fg-on-chrome)">{t.auth.demoRole}</span>}
        <ChevronDown aria-hidden="true" className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-64 rounded-panel border border-border bg-popover p-1.5 shadow-e3">
          <DropdownMenu.RadioGroup value={me.activeRole} onValueChange={(v) => void switchTo(v as Role)}>
            {ROLE_OPTIONS.map((o) => (
              <DropdownMenu.RadioItem
                key={o.role}
                value={o.role}
                className="flex min-h-10 cursor-pointer flex-col justify-center rounded-control px-3 py-1.5 outline-none data-[highlighted]:bg-surface-2 data-[state=checked]:font-bold"
              >
                {o.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
