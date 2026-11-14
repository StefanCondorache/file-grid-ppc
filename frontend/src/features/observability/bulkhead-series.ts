import { CATEGORY_IDS, type CategoryId } from '@/lib/monitoring/contract';
import type { BulkheadSeriesView } from './queries';

/** One colour token and one dash pattern per category, so the lines differ without colour too (A11Y-19). */
export const BULKHEAD_SERIES: Record<CategoryId, { colorVar: string; dash: string }> = {
  meter_readings: { colorVar: '--fg-cat-meter', dash: 'none' },
  fault_records: { colorVar: '--fg-cat-fault', dash: '8 4' },
  connection_documents: { colorVar: '--fg-cat-connection', dash: '2 4' },
  drone_videos: { colorVar: '--fg-cat-drone', dash: '12 4 2 4' },
};

/** One chart row per time step: p95 in seconds per category (null = no sample). */
export type BulkheadRow = { t: string; time: string } & Partial<Record<CategoryId, number | null>>;

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function timeOf(iso: string): string {
  return clock.format(new Date(iso));
}

/** The series on one time axis (the backend sends every category on the same buckets). */
export function toRows(series: BulkheadSeriesView[]): BulkheadRow[] {
  const byT = new Map<string, BulkheadRow>();
  for (const s of series) {
    for (const p of s.points) {
      const row = byT.get(p.t) ?? { t: p.t, time: timeOf(p.t) };
      row[s.category] = p.p95Ms === null ? null : p.p95Ms / 1000;
      byT.set(p.t, row);
    }
  }
  return [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/** The latest p95 (ms) of each category, for the direct end labels; null when the series has no sample. */
export function lastValues(series: BulkheadSeriesView[]): Record<CategoryId, number | null> {
  const out = Object.fromEntries(CATEGORY_IDS.map((c) => [c, null])) as Record<CategoryId, number | null>;
  for (const s of series) {
    const last = [...s.points].reverse().find((p) => p.p95Ms !== null);
    out[s.category] = last?.p95Ms ?? null;
  }
  return out;
}
