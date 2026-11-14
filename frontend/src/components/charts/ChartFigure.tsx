import { useId, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { ChartTable, type ChartColumn } from './ChartTable';

type Props = {
  title: string;
  interpretation?: string;
  columns: ChartColumn[];
  rows: Record<string, ReactNode>[];
  children: ReactNode;
};

/** Every chart: title, the chart as role="img", the Romanian interpretation and a table view (A11Y-19). */
export function ChartFigure({ title, interpretation, columns, rows, children }: Props) {
  const t = useT();
  const id = useId();
  return (
    <figure aria-labelledby={id} className="m-0 flex flex-col gap-3">
      <figcaption id={id} className="text-lg font-bold">
        {title}
      </figcaption>
      <div role="img" aria-label={title}>
        {children}
      </div>
      {interpretation && (
        <p className="rounded-r-panel border-l-4 border-brand-cyan bg-surface-2 px-4 py-3">
          <b className="block">{t.common.interpretation}</b>
          {interpretation}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-link">{t.common.viewAsTable}</summary>
        <ChartTable columns={columns} rows={rows} caption={title} />
      </details>
    </figure>
  );
}
