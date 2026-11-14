import { useId } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';

/** One sentence of a block; `label` names what it is about when a block speaks of several things (S1: a category). */
export type InsightLine = { key: string; label?: string; text: string };

type Props = {
  /** Lets the chart point `aria-describedby` at its interpretation (A11Y-19). */
  interpretationId?: string;
  interpretation: readonly InsightLine[];
  recommendation: readonly InsightLine[];
};

/** FE-10: every statistics block ends with its plain-Romanian interpretation and recommendation, side by side. */
export function Insight({ interpretationId, interpretation, recommendation }: Props) {
  const t = useT();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Block id={interpretationId} title={t.statistics.insight.interpretation} lines={interpretation} className="border-brand-cyan" />
      <Block title={t.statistics.insight.recommendation} lines={recommendation} className="border-ok" />
    </div>
  );
}

function Block({ id, title, lines, className }: { id?: string; title: string; lines: readonly InsightLine[]; className: string }) {
  const headingId = useId();
  const [only] = lines;
  return (
    <div id={id} role="group" aria-labelledby={headingId} className={cn('flex flex-col gap-2 rounded-r-panel border-l-4 bg-surface-2 px-4 py-3', className)}>
      <h3 id={headingId} className="text-base font-bold">
        {title}
      </h3>
      {lines.length === 1 && only && !only.label ? (
        <p>{only.text}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => (
            <li key={line.key}>
              {line.label && <span className="font-semibold">{line.label}: </span>}
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
