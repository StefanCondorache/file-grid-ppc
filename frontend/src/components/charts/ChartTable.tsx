import type { ReactNode } from 'react';

export type ChartColumn = { key: string; label: string; align?: 'left' | 'right' };

/** Table alternative rendered from the same rows as the chart (A11Y-19). */
export function ChartTable({ columns, rows, caption }: { columns: ChartColumn[]; rows: Record<string, ReactNode>[]; caption?: string }) {
  const align = (c: ChartColumn) => (c.align === 'right' ? 'text-right' : 'text-left');
  return (
    <table className="mt-2 w-full border-collapse text-sm">
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={`border-b border-border bg-surface-2 px-3 py-2 font-semibold text-ink-2 ${align(c)}`}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.key} className={`border-b border-border px-3 py-2 ${align(c)}`}>
                {r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
