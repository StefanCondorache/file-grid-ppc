'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { Role } from '@/lib/api/types';
import {
  CATEGORY_IDS,
  type Alert,
  type CategoryId,
  type Comparator,
  type GuaranteeMetric,
  type GuaranteeState,
  type GuaranteeStatus,
} from '@/lib/monitoring/contract';

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

const ALERT_STATES: readonly Alert['state'][] = ['at_risk', 'violated', 'resolved'];
const ROLES: readonly Role[] = ['teren', 'dispecerat', 'racordari', 'auditor', 'admin'];

function toCategory(raw: unknown): CategoryId | undefined {
  const id = String(raw);
  return (CATEGORY_IDS as readonly string[]).includes(id) ? (id as CategoryId) : LEGACY_CATEGORY[id];
}

function toAcknowledgedBy(raw: unknown): Alert['acknowledgedBy'] {
  if (!isObject(raw)) return null;
  const username = typeof raw.username === 'string' ? raw.username : '';
  const displayName = typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : username;
  if (!displayName) return null;
  return { id: typeof raw.id === 'string' ? raw.id : username, username, displayName, role: ROLES.find((r) => r === raw.role) ?? null };
}

/** One alert of `GET /alerts`, `POST /alerts/{id}/acknowledge` or an `alert.raised` / `alert.updated` event; null if untrusted. */
export function toAlert(raw: unknown): Alert | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.raisedAt !== 'string') return null;
  const category = toCategory(raw.category);
  const state = ALERT_STATES.find((s) => s === raw.state);
  if (!category || !state) return null;
  const acknowledgedAt = typeof raw.acknowledgedAt === 'string' ? raw.acknowledgedAt : null;
  return {
    id: raw.id,
    category,
    state,
    raisedAt: raw.raisedAt,
    resolvedAt: typeof raw.resolvedAt === 'string' ? raw.resolvedAt : null,
    causeCode: typeof raw.causeCode === 'string' ? raw.causeCode : '',
    causeFacts: isObject(raw.causeFacts) ? raw.causeFacts : {},
    traceId: typeof raw.traceId === 'string' && raw.traceId !== '' ? raw.traceId : null,
    acknowledgedAt,
    acknowledgedBy: acknowledgedAt === null ? null : toAcknowledgedBy(raw.acknowledgedBy),
  };
}

/** Validates the alerts cache (`{ data, meta }` from REST; the live bridge upserts events into it); newest first. */
export function toAlerts(raw: unknown): Alert[] {
  const items: unknown[] = isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  return items
    .map(toAlert)
    .filter((a): a is Alert => a !== null)
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.id.localeCompare(b.id));
}

/** How many alerts the home list and the banner read: the newest, active and resolved. */
export const ALERTS_PAGE_SIZE = 50;

/**
 * The newest alerts (active and resolved) under the one `qk.alerts` key the live bridge feeds with `alert.raised` and
 * `alert.updated`. The banner takes the active ones from it; the home page lists them all.
 */
export function useAlerts() {
  return useQuery({
    queryKey: qk.alerts,
    queryFn: () => unwrap(api.GET('/alerts', { params: { query: { state: 'all', pageSize: ALERTS_PAGE_SIZE } } })),
    select: toAlerts,
  });
}

/** Puts one alert (as the server sent it) into the alerts cache, replacing the same id, as the live bridge does. */
function upsertAlert(qc: QueryClient, alert: unknown): void {
  if (!isObject(alert)) return;
  qc.setQueryData(qk.alerts, (old: unknown) => {
    const list: unknown[] = isObject(old) && Array.isArray(old.data) ? old.data : [];
    return { ...(isObject(old) ? old : {}), data: [alert, ...list.filter((a) => !isObject(a) || a.id !== alert.id)] };
  });
}

/** `POST /alerts/{alertId}/acknowledge`: the server records who and when (idempotent) and audits it. */
export function useAcknowledgeAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => unwrap(api.POST('/alerts/{alertId}/acknowledge', { params: { path: { alertId } } })),
    onSuccess: (alert: unknown) => upsertAlert(qc, alert),
  });
}
