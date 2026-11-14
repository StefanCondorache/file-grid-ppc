'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { CATEGORY_IDS, type CategoryId, type Comparator, type GuaranteeMetric, type GuaranteeState, type GuaranteeStatus } from '@/lib/monitoring/contract';

/** The OpenAPI proposal's category ids, accepted while mocks or baselines still send them (docs/api.md differences). */
const LEGACY_CATEGORY: Record<string, CategoryId> = {
  meter: 'meter_readings',
  fault: 'fault_records',
  connection: 'connection_documents',
  drone: 'drone_videos',
};
const STATES: readonly GuaranteeState[] = ['ok', 'at_risk', 'violated'];
const COMPARATORS: readonly Comparator[] = ['lt', 'lte', 'eq', 'gte', 'gt'];

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const decimalOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

function toMetric(raw: unknown): GuaranteeMetric | null {
  if (!isObject(raw) || typeof raw.key !== 'string') return null;
  return {
    key: raw.key,
    value: decimalOrNull(raw.value),
    unit: typeof raw.unit === 'string' ? raw.unit : null,
    threshold: decimalOrNull(raw.threshold),
    comparator: COMPARATORS.find((c) => c === raw.comparator) ?? null,
  };
}

/**
 * Validates `GET /guarantees` `{ data }` (and the `guarantees.status` snapshot the live bridge writes to the same key):
 * never trust external data. Unknown categories or states are dropped; the result is in board order.
 */
export function toGuarantees(raw: unknown): GuaranteeStatus[] {
  const items: unknown[] = isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  const byCategory = new Map<CategoryId, GuaranteeStatus>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const id = String(item.category);
    const category = (CATEGORY_IDS as readonly string[]).includes(id) ? (id as CategoryId) : LEGACY_CATEGORY[id];
    const state = STATES.find((s) => s === item.state);
    if (!category || !state) continue;
    byCategory.set(category, {
      category,
      state,
      causeCode: typeof item.causeCode === 'string' ? item.causeCode : null,
      causeFacts: isObject(item.causeFacts) ? item.causeFacts : {},
      metrics: Array.isArray(item.metrics) ? item.metrics.map(toMetric).filter((m): m is GuaranteeMetric => m !== null) : [],
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    });
  }
  return CATEGORY_IDS.flatMap((c) => byCategory.get(c) ?? []);
}

/** The four business guarantees; the live stream (or the polling fallback) keeps the same key fresh. */
export function useGuarantees() {
  return useQuery({ queryKey: qk.guarantees, queryFn: () => unwrap(api.GET('/guarantees')), select: toGuarantees });
}
