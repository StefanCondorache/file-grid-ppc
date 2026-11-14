import type { ReactNode } from 'react';
import { ChartTable, type ChartColumn } from '@/components/charts/ChartTable';
import { useT } from '@/lib/i18n';

type Props = { title: string; columns: ChartColumn[]; rows: Record<string, ReactNode>[] };

/** "Vezi ca tabel" under a statistics chart: its data table (A11Y-19), built from the same answer, closed by default. */
export function TableDetails({ title, columns, rows }: Props) {
  const t = useT();
  return (
    <details>
      <summary className="cursor-pointer text-sm font-semibold text-link">{t.common.viewAsTable}</summary>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A11Y-23: a table that scrolls sideways on narrow screens sits in a focusable named region, so keyboard users can scroll it (axe scrollable-region-focusable). */}
      <div role="region" aria-label={title} tabIndex={0} className="overflow-x-auto">
        <ChartTable columns={columns} rows={rows} caption={title} />
      </div>
    </details>
  );
}
