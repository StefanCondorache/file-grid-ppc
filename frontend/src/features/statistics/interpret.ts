import { plural } from '@/lib/i18n';
import { formatInt, formatPercent } from '@/lib/i18n/format';
import { statistics as t } from '@/lib/i18n/ro/statistics';
import {
  STATS_CATEGORIES,
  type ComparisonMetric,
  type GridInsights,
  type Interpretation,
  type MeterAnomaly,
  type PeriodComparison,
  type StatsCategoryId,
  type StorageFitItem,
  type StorageId,
  type StoragePerformance,
  type Zone,
} from './contract';

/**
 * OQ-7: the Romanian interpretation and recommendation under each statistics chart. The backend's `text` and
 * `recommendation` win, each on its own, when present (the real backend leaves `recommendation` null when nothing needs
 * changing). Otherwise they are templated from `facts`, with the numbers taken from the same answer the chart draws, so
 * the sentence quotes what the chart shows. The real backend sends fewer facts than the proposal (no S1 `runnerUp` or
 * `speedup`, no S2 `mostAffected`, and its S2 `factor` is the meter rate), so the missing ones are derived from the
 * measurements.
 */
export type Interpreted = { text: string; recommendation: string };

const NBSP = ' ';
/** Like the backend: fewer measurements than this never make a storage "the fastest". */
const MIN_SAMPLES = 5;
/** Two storages whose p95 differ by less than this factor are "equally fast". */
const EVEN_BELOW = 1.2;
/** The stormed category's load is quoted only from this factor up ("au crescut de 10×"). */
const LOAD_CALLOUT = 1.5;

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

function choose(backend: Interpretation<unknown>, text: () => string, recommendation: () => string): Interpreted {
  return {
    text: present(backend.text) ? backend.text : text(),
    recommendation: present(backend.recommendation) ? backend.recommendation : recommendation(),
  };
}

const decimal = (n: number, min: number, max: number) =>
  new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max }).format(n).replace(/\./g, NBSP);
/** The factor before "×": "3", "2,7", "10". */
const times = (n: number) => decimal(n, 0, 1);
/** Milliseconds below 0,1 s ("42 ms"), seconds above ("0,6 s", "0,25 s", "3,4 s"). */
const duration = (ms: number) => (ms < 100 ? `${formatInt(ms)}${NBSP}ms` : `${decimal(ms / 1000, 1, 2)}${NBSP}s`);
/** A latency as the sentences quote it, so the charts and tables print the very same "0,6 s". */
export const formatLatency = duration;
/** Signed whole percent: "+467 %", "−12 %". */
function delta(pct: number): string {
  const whole = Math.round(pct);
  return `${whole > 0 ? '+' : whole < 0 ? '−' : ''}${formatPercent(Math.abs(whole) / 100, 0)}`;
}
/** A change as the sentences quote it, so the chart and table print the very same "+467 %". */
export const formatDelta = delta;
const kwh = (n: number) => `${decimal(n, 2, 2)}${NBSP}kWh`;
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
/** b ÷ a to 1 decimal; null when a is 0 or a value is missing. */
const ratio = (a: number | null | undefined, b: number | null | undefined) =>
  a && b !== null && b !== undefined ? Math.round((b / a) * 10) / 10 : null;

const storageName = (id: StorageId) => t.storage[id] ?? String(id).toUpperCase();
const zoneName = (id: Zone) => t.zone[id] ?? { label: String(id), definite: String(id) };

type Measured = StoragePerformance & { p95Ms: number };

/** S1: which storage served this category fastest, and what to do about the policy. */
export function interpretS1(item: StorageFitItem): Interpreted {
  const { facts } = item.interpretation;
  const subject = t.category[item.category].subject;
  const measured = item.storages
    .filter((s): s is Measured => s.samples >= MIN_SAMPLES && s.p95Ms !== null)
    .sort((x, y) => x.p95Ms - y.p95Ms);
  const find = (id: StorageId | null | undefined) => measured.find((s) => s.storage === id);
  const fastest = find(facts.fastest) ?? measured[0];
  const runnerUp = find(facts.runnerUp) ?? measured.find((s) => s !== fastest);
  const factsPair = fastest?.storage === facts.fastest && runnerUp?.storage === facts.runnerUp;
  const speedup = fastest && runnerUp ? ((factsPair ? facts.speedup : null) ?? ratio(fastest.p95Ms, runnerUp.p95Ms)) : null;
  const clearlyFaster = speedup !== null && speedup >= EVEN_BELOW;
  const recommended = storageName(item.recommendedStorage);

  return choose(
    item.interpretation,
    () => {
      if (!fastest) return t.s1.notEnough;
      if (!runnerUp) {
        return t.s1.onlyOne({
          subject,
          storage: storageName(fastest.storage),
          p95: duration(fastest.p95Ms),
          operations: plural(fastest.samples, t.s1.operations),
        });
      }
      const fast = storageName(fastest.storage);
      const slow = storageName(runnerUp.storage);
      const fastP95 = duration(fastest.p95Ms);
      const slowP95 = duration(runnerUp.p95Ms);
      return clearlyFaster
        ? t.s1.faster({ subject, times: times(speedup), fast, slow, fastP95, slowP95 })
        : t.s1.asFast({ subject, first: fast, second: slow, firstP95: fastP95, secondP95: slowP95 });
    },
    () => {
      if (facts.primaryStorage && facts.primaryStorage !== item.recommendedStorage) {
        return t.s1.move({ subject, current: storageName(facts.primaryStorage), recommended });
      }
      if (fastest && fastest.storage !== item.recommendedStorage) {
        return t.s1.keepAndWatch({ subject, recommended, faster: storageName(fastest.storage) });
      }
      if (runnerUp && clearlyFaster) {
        return t.s1.keepFaster({ subject, recommended, times: times(speedup), slow: storageName(runnerUp.storage) });
      }
      return t.s1.keep({ subject, recommended });
    },
  );
}

type P95Change = { a: number; b: number; deltaPct: number | null };

/** The backend's isolation rule: a category kept its response time when p95 B ≤ 1,5 × A + 50 ms. */
const degraded = (change: P95Change) => change.b > change.a * 1.5 + 50;

/** S2: which category the peak hit, how hard, and whether the bulkheads kept the others flat. */
export function interpretS2(cmp: PeriodComparison): Interpreted {
  const { facts } = cmp.interpretation;
  const row = (category: StatsCategoryId, metric: ComparisonMetric) =>
    cmp.rows.find((r) => r.category === category && r.metric === metric);
  const p95 = (category: StatsCategoryId): P95Change | null => {
    const r = row(category, 'p95Ms');
    return r && r.a !== null && r.b !== null ? { a: r.a, b: r.b, deltaPct: r.deltaPct } : null;
  };
  const slower = (category: StatsCategoryId) => {
    const change = p95(category);
    return change !== null && change.b > change.a;
  };
  const rise = (category: StatsCategoryId) => p95(category)?.deltaPct ?? 0;

  // The proposal names the stormed category; otherwise it is the one whose p95 rose most.
  const affected: StatsCategoryId | null =
    facts.mostAffected && slower(facts.mostAffected)
      ? facts.mostAffected
      : (STATS_CATEGORIES.filter(slower).sort((x, y) => rise(y) - rise(x))[0] ?? null);
  const change = affected ? p95(affected) : null;
  const ops = affected ? row(affected, 'opsPerS') : undefined;
  const load = affected ? ((facts.mostAffected === affected ? facts.factor : null) ?? ratio(ops?.a, ops?.b)) : null;
  const othersSlowed = STATS_CATEGORIES.filter((c) => {
    const other = c === affected ? null : p95(c);
    return other !== null && degraded(other);
  });

  return choose(
    cmp.interpretation,
    () => {
      if (!affected || !change) return t.s2.noneSlower({ a: cmp.periodA.label, b: cmp.periodB.label });
      const shared = {
        period: cmp.periodB.label,
        from: duration(change.a),
        to: duration(change.b),
        delta: change.deltaPct === null ? null : delta(change.deltaPct),
      };
      const lead =
        load !== null && load >= LOAD_CALLOUT
          ? t.s2.grew({ ...shared, subject: t.category[affected].subject, load: times(load) })
          : t.s2.slower({ ...shared, bare: t.category[affected].bare });
      const isolation = facts.isolated
        ? t.s2.isolated
        : t.s2.notIsolated(othersSlowed.length ? t.and(othersSlowed.map((c) => t.category[c].subject)) : null);
      return `${lead} ${isolation}`;
    },
    () => {
      if (!facts.isolated) return t.s2.raiseConcurrency;
      return affected && change && degraded(change) ? t.s2.scaleOut(t.category[affected].bare) : t.s2.noChange;
    },
  );
}

/** The zone with the most anomalous readings; on a tie, the one with the newest reading (the list is newest first). */
function mostAnomalousZone(anomalies: readonly MeterAnomaly[]): Zone | null {
  const counts = new Map<Zone, number>();
  for (const a of anomalies) counts.set(a.zone, (counts.get(a.zone) ?? 0) + 1);
  let best: Zone | null = null;
  for (const [zone, count] of counts) if (best === null || count > counts.get(best)!) best = zone;
  return best;
}

/** S3: where the faults are, when consumption peaks, and which meters to check. */
export function interpretS3(insights: GridInsights): Interpreted {
  const { facts } = insights.interpretation;
  const zonesWithFaults = insights.faultsByZone.filter((z) => z.count > 0).sort((x, y) => y.count - x.count);
  const topZone = facts.topFaultZone ?? zonesWithFaults[0]?.zone ?? null;
  const top = insights.faultsByZone.find((z) => z.zone === topZone);
  const total = facts.faultsTotal ?? insights.faultsByZone.reduce((sum, z) => sum + z.count, 0);
  const others = zonesWithFaults.filter((z) => z.zone !== topZone);
  const least = others[others.length - 1];
  const versus = top && least ? ratio(least.count, top.count) : null;

  const readings = insights.consumptionByHourZone;
  const byKwh = [...readings].sort((x, y) => y.avgKwh - x.avgKwh);
  const peakHour = facts.peakHour ?? byKwh[0]?.hour ?? null;
  const peakZone = facts.peakZone ?? byKwh.find((r) => r.hour === peakHour)?.zone ?? null;
  const peak = readings.find((r) => r.hour === peakHour && r.zone === peakZone);
  const anomalies = facts.anomalies ?? insights.anomalies.length;
  const anomalous = anomalies > 0 ? plural(anomalies, t.s3.anomalous) : null;

  return choose(
    insights.interpretation,
    () => {
      const faults = topZone
        ? t.s3.faults({
            zone: zoneName(topZone).definite,
            count: top ? formatInt(top.count) : null,
            total: top ? formatInt(total) : null,
            times: versus !== null && versus > 1 ? times(versus) : null,
            versus: least ? zoneName(least.zone).definite : null,
          })
        : t.s3.noFaults;
      const meters =
        peakHour !== null
          ? t.s3.consumption({
              hour: hour(peakHour),
              zone: peakZone ? zoneName(peakZone).label : null,
              kwh: peak ? kwh(peak.avgKwh) : null,
              anomalous,
            })
          : anomalous
            ? t.s3.anomalousOnly(anomalous)
            : t.s3.noReadings;
      return `${faults} ${meters}`;
    },
    () => {
      if (anomalies > 0) {
        const zone = mostAnomalousZone(insights.anomalies);
        return t.s3.checkMeters(zone ? zoneName(zone).definite : null);
      }
      return topZone ? t.s3.inspect(zoneName(topZone).label) : t.s3.nothing;
    },
  );
}
