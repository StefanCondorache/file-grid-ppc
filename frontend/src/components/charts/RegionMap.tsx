import { useId } from 'react';
import type { Zone } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatInt } from '@/lib/i18n/format';

/** One step of the single-hue sequential ramp in tokens.css: `--fg-seq-1` (lightest) to `--fg-seq-5` (deepest). */
export type SeqStep = 1 | 2 | 3 | 4 | 5;
const STEPS: readonly SeqStep[] = [1, 2, 3, 4, 5];
const seqFill = (step: SeqStep) => `var(--fg-seq-${step})`;

/**
 * The step of a count on a 0…max scale: 0 alone on the lightest step, then four equal bands up to the busiest region,
 * which always takes the deepest one. A region without faults never shares a step with one that has some.
 */
export function seqStep(count: number, max: number): SeqStep {
  if (count <= 0 || max <= 0) return 1;
  return Math.min(5, 1 + Math.ceil((4 * count) / max)) as SeqStep;
}

/** The three distribution regions, west to east, as drawn. */
export const MAP_ZONES = ['banat', 'muntenia', 'dobrogea'] as const satisfies readonly Zone[];

/**
 * FA-15: hand-simplified outlines on a 300 × 200 canvas (the 05-statistici mockup), side by side west to east. Schematic
 * on purpose: no geo library, no tiles, not to scale. `label` is the centre of the region's name plate.
 */
const SHAPES: Readonly<Record<Zone, { d: string; label: { x: number; y: number } }>> = {
  banat: { d: 'M10 70 L70 40 L110 60 L100 120 L40 140 L12 110 Z', label: { x: 56, y: 94 } },
  muntenia: { d: 'M110 60 L210 70 L215 150 L120 170 L100 120 Z', label: { x: 160, y: 112 } },
  dobrogea: { d: 'M210 70 L272 46 L296 104 L266 168 L215 150 Z', label: { x: 250, y: 108 } },
};

/**
 * Name plate size: the text sits on the card colour, so it reads the same on every step of the ramp and in both themes.
 * Every plate stays at least 3 units inside its region.
 */
const PLATE = { width: 62, height: 40 } as const;

export type RegionCount = { zone: Zone; name: string; count: number };

type Props = {
  regions: readonly RegionCount[];
  /** The map's accessible name; it should carry every count ("Avarii pe zone: Muntenia 38, …"). */
  title: string;
  /** What the legend counts ("Avarii"). */
  legend: string;
  className?: string;
};

/**
 * S3 region map (FA-15, A11Y charts): three `<path>`s filled from the sequential ramp by their count, a 2 px ink
 * outline, a name and count label on every region, and a legend labelled with numbers. The table alternative is the
 * caller's: the map is not a keyboard stop.
 */
export function RegionMap({ regions, title, legend, className }: Props) {
  const titleId = useId();
  const max = Math.max(0, ...regions.map((r) => r.count));
  const region = (zone: Zone) => regions.find((r) => r.zone === zone) ?? { zone, name: zone, count: 0 };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <svg viewBox="0 0 300 200" role="img" aria-labelledby={titleId} className="block h-auto w-full">
        <title id={titleId}>{title}</title>
        {MAP_ZONES.map((zone) => {
          const step = seqStep(region(zone).count, max);
          return (
            <path
              key={zone}
              data-zone={zone}
              data-step={step}
              d={SHAPES[zone].d}
              fill={seqFill(step)}
              stroke="var(--fg-ink)"
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {MAP_ZONES.map((zone) => {
          const { name, count } = region(zone);
          const { x, y } = SHAPES[zone].label;
          return (
            <g key={zone} data-region-label>
              <rect
                x={x - PLATE.width / 2}
                y={y - PLATE.height / 2}
                width={PLATE.width}
                height={PLATE.height}
                rx={6}
                fill="var(--fg-surface)"
                stroke="var(--fg-line-strong)"
              />
              <text data-name x={x} y={y - 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--fg-ink-2)">
                {name}
              </text>
              <text data-count x={x} y={y + 14} textAnchor="middle" fontSize={18} fontWeight={700} fill="var(--fg-ink)">
                {formatInt(count)}
              </text>
            </g>
          );
        })}
      </svg>
      {max > 0 && (
        // Decoration for sighted readers only: the map's name and the table carry every count.
        <div data-legend aria-hidden="true" className="flex items-center justify-center gap-2 text-[13px] text-ink-2">
          <span className="font-semibold">{legend}</span>
          <span data-bound>0</span>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" className="h-3 w-28">
            {STEPS.map((step, i) => (
              <rect key={step} x={i * 20} y={0} width={20} height={12} fill={seqFill(step)} stroke="var(--fg-ink)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <span data-bound>{formatInt(max)}</span>
        </div>
      )}
    </div>
  );
}
