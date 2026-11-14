'use client';

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { decimal, seconds } from '@/features/guarantees/sentences';
import { CATEGORY_IDS, type CategoryId } from '@/lib/monitoring/contract';
import { BULKHEAD_SERIES, type BulkheadRow } from './bulkhead-series';

type Props = {
  rows: BulkheadRow[];
  names: Record<CategoryId, string>;
  targetS: number | null;
  targetLabel: string;
  yLabel: string;
};

const tick = { fill: 'var(--fg-ink-3)', fontSize: 12 };

/** The Recharts part of the bulkhead chart, loaded on the client only (next/dynamic). Tooltips are plain text. */
export default function BulkheadLines({ rows, names, targetS, targetLabel, yLabel }: Props) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={rows} margin={{ top: 20, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="var(--fg-grid)" vertical={false} />
        <XAxis dataKey="time" tick={tick} stroke="var(--fg-axis)" minTickGap={32} />
        <YAxis
          tick={tick}
          stroke="var(--fg-axis)"
          width={56}
          tickFormatter={(v: number) => decimal(v)}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--fg-ink-3)', fontSize: 12 }}
        />
        <Tooltip
          isAnimationActive={false}
          contentStyle={{ background: 'var(--fg-surface)', border: '1px solid var(--fg-line)', color: 'var(--fg-ink)', borderRadius: 6 }}
          formatter={(value, name) => [typeof value === 'number' ? seconds(value * 1000) : '—', names[name as CategoryId] ?? String(name)]}
        />
        {targetS !== null && (
          <ReferenceLine
            y={targetS}
            stroke="var(--fg-crit)"
            strokeDasharray="4 4"
            label={{ value: targetLabel, position: 'insideTopRight', fill: 'var(--fg-crit-ink)', fontSize: 12 }}
          />
        )}
        {CATEGORY_IDS.map((c) => (
          <Line
            key={c}
            dataKey={c}
            name={c}
            type="monotone"
            stroke={`var(${BULKHEAD_SERIES[c].colorVar})`}
            strokeDasharray={BULKHEAD_SERIES[c].dash}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
