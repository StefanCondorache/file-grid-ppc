'use client';

import { FlaskConical } from 'lucide-react';
import { mockConfig } from '@/lib/config/mocks';
import { useT } from '@/lib/i18n';

/** Always visible while any group is mocked (FE-18). */
export function MockMarker() {
  const t = useT();
  const config = mockConfig();
  if (!config.enabled) return null;
  const which = config.groups === 'all' ? 'toate grupurile' : config.groups.join(', ');
  return (
    <span
      className="inline-flex h-[30px] items-center gap-1.5 rounded-chip bg-warn px-2.5 text-xs font-bold tracking-wide text-(--fg-on-warn) uppercase shadow-[inset_0_0_0_1.5px_var(--fg-warn-border)]"
      title={`${t.common.mockMarker}: ${which}`}
    >
      <FlaskConical aria-hidden="true" className="size-4" />
      {t.common.mockMarker}
      <span className="sr-only">: {which}</span>
    </span>
  );
}
