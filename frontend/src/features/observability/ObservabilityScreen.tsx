'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Forbidden } from '@/components/Forbidden';
import { useMe } from '@/features/auth/queries';
import { roleLabel } from '@/features/auth/roles';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import type { MatrixWindow } from '@/lib/monitoring/contract';
import { BulkheadChart } from './BulkheadChart';
import { MetricsMatrix } from './MetricsMatrix';
import { MATRIX_WINDOWS, toMatrixWindow } from './queries';
import { WindowSelect } from './WindowSelect';

/**
 * Observabilitate (SC-07, FE-09; auditor and admin): the category × storage matrix for a window kept in the URL
 * (`/observability?window=1h`, frontend-architecture §3), so a view can be shared and survives a reload.
 */
export function ObservabilityScreen() {
  const t = useT().monitoring.observability;
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const matrixWindow = toMatrixWindow(params.get('window'));

  if (me.data && !can(me.data, 'view_observability')) return <Forbidden roleLabel={roleLabel(me.data.activeRole)} />;

  const setWindow = (next: MatrixWindow) => {
    const query = new URLSearchParams(params.toString());
    query.set('window', next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-10">
    <section aria-labelledby="matrix-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 id="matrix-title" className="text-[22px] font-bold">
            {t.matrixTitle}
          </h2>
          <p className="text-ink-2">{t.matrixLead}</p>
        </div>
        <WindowSelect value={matrixWindow} windows={MATRIX_WINDOWS} onChange={setWindow} />
      </div>
      <MetricsMatrix window={matrixWindow} />
    </section>
    <BulkheadChart />
    </div>
  );
}
