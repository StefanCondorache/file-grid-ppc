import { useMemo } from 'react';
import { formatPercent } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { formatLimit } from '@/lib/upload/plan';
import { bitsetHas } from '@/lib/upload/repo';

/** A file never gets more cells than this; a big file folds ⌈parts/256⌉ parts into each cell (components.md). */
export const MAX_CELLS = 256;

export type CellState = 'done' | 'flight' | 'failed' | 'pending';

/** Server-confirmed parts of a bitset (bit n-1 = part n). */
export function confirmedCount(parts: number, confirmed: Uint8Array): number {
  let n = 0;
  for (let p = 1; p <= parts; p++) if (bitsetHas(confirmed, p)) n++;
  return n;
}

/**
 * Whole percent of the server-confirmed parts. It only counts confirmed parts, so it never goes back when a part in
 * flight is dropped (offline, pause), and it says 100 only when every part is confirmed.
 */
export function confirmedPercent(parts: number, done: number): number {
  if (parts <= 0) return 0;
  if (done >= parts) return 100;
  return Math.min(99, Math.round((done / parts) * 100));
}

/** "58 %, 712 MB din 1,23 GB" (NBSP before the units); sizes without trailing zero decimals. */
export function progressText(percent: number, bytes: number, size: number): string {
  return `${formatPercent(percent / 100, 0)}, ${formatLimit(bytes)} din ${formatLimit(size)}`;
}

/** One state per cell: a failed part shows first, then a part in flight; a cell is done when all its parts are. */
export function chunkCells(parts: number, confirmed: Uint8Array, inFlight: readonly number[], failed: readonly number[]): CellState[] {
  if (parts <= 0) return [];
  const perCell = Math.ceil(parts / MAX_CELLS);
  const flying = new Set(inFlight);
  const failing = new Set(failed);
  const cells: CellState[] = [];
  for (let start = 1; start <= parts; start += perCell) {
    const end = Math.min(parts, start + perCell - 1);
    let state: CellState = 'done';
    for (let p = start; p <= end; p++) {
      if (failing.has(p)) {
        state = 'failed';
        break;
      }
      if (flying.has(p)) state = 'flight';
      else if (state === 'done' && !bitsetHas(confirmed, p)) state = 'pending';
    }
    cells.push(state);
  }
  return cells;
}

const CELL_CLASS: Record<CellState, string> = {
  done: 'bg-(--fg-chunk-done)',
  // "Breathes" while the part is on the wire; still under reduced motion.
  flight: 'bg-(--fg-chunk-flight) animate-pulse motion-reduce:animate-none',
  failed: 'bg-transparent shadow-[inset_0_0_0_1.5px_var(--fg-chunk-failed)]',
  pending: 'bg-(--fg-chunk-pending)',
};

export interface ChunkGridProps {
  /** Part count fixed by the server (POST /uploads). */
  parts: number;
  /** Bitset of server-confirmed parts (the store's `confirmed`). */
  confirmed: Uint8Array;
  /** Parts on the wire now. */
  inFlight: readonly number[];
  /** Parts waiting for a retry after a failure. */
  failed: readonly number[];
  /** Bytes of the confirmed parts, and the file size, for the spoken progress. */
  bytes: number;
  size: number;
  /** Id of the file name, so the progress bar is named after the file. */
  labelledBy?: string;
  /** Appended to the spoken progress: the state, a retry countdown or the time left. */
  detail?: string;
  className?: string;
}

/**
 * Chunk-grid progress (components.md): a `role=progressbar` with Romanian `aria-valuetext`; the cells themselves are
 * decoration (`aria-hidden`), so colour never carries the meaning alone (A11Y-12).
 */
export function ChunkGrid({ parts, confirmed, inFlight, failed, bytes, size, labelledBy, detail, className }: ChunkGridProps) {
  const t = useT();
  const cells = useMemo(() => chunkCells(parts, confirmed, inFlight, failed), [parts, confirmed, inFlight, failed]);
  const done = useMemo(() => confirmedCount(parts, confirmed), [parts, confirmed]);
  const percent = confirmedPercent(parts, done);
  const valueText = progressText(percent, bytes, size);
  return (
    <div
      role="progressbar"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : t.upload.progressLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={detail ? `${valueText}, ${detail}` : valueText}
      className={className}
    >
      <div aria-hidden="true" className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5 sm:grid-cols-[repeat(48,minmax(0,1fr))]">
        {cells.map((state, i) => (
          <i key={i} data-cell={state} className={cn('block aspect-square rounded-[var(--fg-radius-chunk)]', CELL_CLASS[state])} />
        ))}
      </div>
    </div>
  );
}

/** The cell legend, once per list: what each colour means, in words. */
export function ChunkLegend({ className }: { className?: string }) {
  const t = useT();
  const items: [CellState, string][] = [
    ['done', t.upload.legend.done],
    ['flight', t.upload.legend.flight],
    ['failed', t.upload.legend.failed],
    ['pending', t.upload.legend.pending],
  ];
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2', className)}>
      {items.map(([state, label]) => (
        <li key={state} className="inline-flex items-center gap-1.5">
          <i aria-hidden="true" className={cn('inline-block size-3 rounded-[var(--fg-radius-chunk)]', CELL_CLASS[state], 'animate-none')} />
          {label}
        </li>
      ))}
    </ul>
  );
}
