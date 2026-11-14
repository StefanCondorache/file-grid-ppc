import { plural } from '@/lib/i18n';
import { ro } from '@/lib/i18n/ro';
import type { GuaranteeStatus } from '@/lib/monitoring/contract';

const NBSP = '\u00A0';
const upToOneDecimal = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 });

/** Romanian number with at most one decimal and NBSP thousands: `3,4`, `2`, `1 284 532`. */
export function decimal(n: number): string {
  return upToOneDecimal.format(n).replace(/\./g, NBSP);
}

/** Milliseconds as seconds: `3,4 s`, `2 s`. */
export function seconds(ms: number): string {
  return `${decimal(ms / 1000)}${NBSP}s`;
}

/** A percentage value (0–100): `98,5 %`, `100 %`. */
export function percent(pct: number): string {
  return `${decimal(pct)}${NBSP}%`;
}

/** A finite number from a fact or a metric's decimal string; null otherwise. */
export function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The value and threshold of one of the guarantee's metrics (an `ok` verdict carries no causeFacts). */
export function metricOf(g: GuaranteeStatus, key: string): { value: number | null; threshold: number | null } {
  const m = g.metrics.find((x) => x.key === key);
  return { value: toNumber(m?.value), threshold: toNumber(m?.threshold) };
}

/**
 * The plain-Romanian sentence of a guarantee card. The backend decides the state; this only words it, from the
 * cause code and its facts (backend/src/guarantees), falling back to the metrics for `ok` and to the state alone.
 */
export function sentenceFor(g: GuaranteeStatus): string {
  const s = ro.monitoring.sentences;
  const facts = g.causeFacts;

  switch (g.category) {
    case 'fault_records': {
      const metric = metricOf(g, 'uploadToAvailableP95Ms');
      const p95 = toNumber(facts.p95Ms) ?? metric.value;
      const target = toNumber(facts.targetMs) ?? metric.threshold;
      if (target === null) break;
      if (p95 === null) return s.faultNoSamples(seconds(target));
      const relation = p95 > target ? 'above' : g.state === 'ok' ? 'below' : 'near';
      return s.faultTime(seconds(p95), relation, seconds(target));
    }
    case 'meter_readings': {
      if (g.causeCode === 'METER_LOSS_UNKNOWN') return s.meterUnknown;
      const lost = toNumber(facts.lost);
      if (g.causeCode === 'METER_READINGS_LOST' && lost !== null) {
        return s.meterLost(plural(lost, s.meterLostForms), decimal(toNumber(facts.max) ?? 0));
      }
      if (g.state === 'ok') return s.meterOk;
      break;
    }
    case 'connection_documents': {
      const pct = toNumber(facts.encryptedPct);
      if (g.causeCode === 'CONNECTION_NOT_ENCRYPTED' && pct !== null) {
        return s.connectionNotEncrypted(percent(pct), percent(toNumber(facts.minPct) ?? 100));
      }
      const reveals = toNumber(facts.unmaskEventsToday);
      const max = toNumber(facts.max);
      if (g.causeCode === 'CONNECTION_UNMASK_SPIKE' && reveals !== null && max !== null) {
        return s.connectionUnmaskSpike(plural(reveals, s.connectionTimesForms), decimal(max));
      }
      if (g.state === 'ok') return s.connectionOk;
      break;
    }
    case 'drone_videos': {
      const rate = toNumber(facts.successRate);
      const min = toNumber(facts.min);
      if (rate !== null && min !== null) {
        if (g.causeCode === 'DRONE_SUCCESS_BELOW_TARGET') return s.droneBelow(percent(rate * 100), percent(min * 100));
        if (g.causeCode === 'DRONE_SUCCESS_NEAR_TARGET') return s.droneNear(percent(rate * 100), percent(min * 100));
      }
      if (g.state === 'ok') return s.droneOk;
      break;
    }
  }
  return s.fallback[g.state];
}
