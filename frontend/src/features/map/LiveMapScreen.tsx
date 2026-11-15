'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { call } from '@/features/demo/api';
import { useMeterCounters } from '@/features/meters/queries';
import { useLiveRefresh } from '@/features/observability/queries';
import { toGridInsights } from '@/features/statistics/queries';
import { formatInt } from '@/lib/i18n/format';
import { ro } from '@/lib/i18n/ro';
import type { Zone } from '@/lib/upload/contract';
import { COUNTIES, MAP_HEIGHT, MAP_WIDTH, type County } from './counties';

const t = ro.map;
const ZONES: readonly Zone[] = ['muntenia', 'banat', 'dobrogea'];
const ACTIVE = COUNTIES.filter((c) => c.zone !== null);
const COUNTIES_OF: Record<Zone, County[]> = {
  muntenia: ACTIVE.filter((c) => c.zone === 'muntenia'),
  banat: ACTIVE.filter((c) => c.zone === 'banat'),
  dobrogea: ACTIVE.filter((c) => c.zone === 'dobrogea'),
};
const SEQ = ['var(--fg-seq-1)', 'var(--fg-seq-2)', 'var(--fg-seq-3)', 'var(--fg-seq-4)', 'var(--fg-seq-5)'];

/** Where each zone's name sits: above Banat and Dobrogea, left of Bucharest (its markers crowd the centre). */
const LABEL_AT: Record<Zone, { dx: number; dy: number; anchor: 'middle' | 'end' }> = {
  banat: { dx: 0, dy: -75, anchor: 'middle' },
  muntenia: { dx: -45, dy: 10, anchor: 'end' },
  dobrogea: { dx: 30, dy: -70, anchor: 'middle' },
};

type Layer = 'consumption' | 'faults' | 'anomalies' | 'readings';
type Spark = { id: number; x: number; y: number };
type FaultFile = { id: string; displayName: string; zone: Zone | null; createdAt: string };

/** Stable 32-bit hash: places an outage or a meter on one county of its zone, always the same one. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A point inside the zone: a county picked by the key, then a small jitter around its centre. */
function placeOf(zone: Zone, key: string): { x: number; y: number; county: County } {
  const list = COUNTIES_OF[zone];
  const h = hash(key);
  const county = list[h % list.length] as County;
  const spread = county.id === 'Bucuresti' ? 3 : 14;
  return { x: county.cx + (((h >>> 8) % 100) / 50 - 1) * spread, y: county.cy + (((h >>> 16) % 100) / 50 - 1) * spread, county };
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return t.agoSeconds(s);
  if (s < 3600) return t.agoMinutes(Math.round(s / 60));
  if (s < 86_400) return t.agoHours(Math.round(s / 3600));
  return t.agoDays(Math.round(s / 86_400));
}

function useFaults(live: boolean) {
  return useQuery({
    queryKey: ['map', 'faults'],
    queryFn: async () => {
      const body = await call<{ data?: FaultFile[] }>('GET', '/files?category=fault_records&pageSize=60&limit=60');
      return Array.isArray(body?.data) ? body.data : [];
    },
    refetchInterval: live ? 5_000 : false,
  });
}

function useGrid(live: boolean) {
  return useQuery({
    queryKey: ['map', 'grid'],
    queryFn: async () => toGridInsights(await call<unknown>('GET', '/statistics/grid-insights')),
    refetchInterval: live ? 15_000 : false,
  });
}

function useSimulatorMode(live: boolean) {
  return useQuery({
    queryKey: ['map', 'simulator'],
    queryFn: async () => (await call<{ mode?: string }>('GET', '/meters/simulator'))?.mode ?? 'normal',
    refetchInterval: live ? 5_000 : false,
  });
}

/** Sparks where readings arrive: per tick, as many as the zone's live rate (capped), each fading out in 1,6 s. */
function useSparks(rates: Record<Zone, number>, on: boolean): Spark[] {
  const [sparks, setSparks] = useState<Spark[]>([]);
  const next = useRef(0);
  const ratesRef = useRef(rates);
  ratesRef.current = rates;
  useEffect(() => {
    if (!on) {
      setSparks([]);
      return;
    }
    const timer = window.setInterval(() => {
      const now = next.current;
      const fresh: Spark[] = [];
      for (const zone of ZONES) {
        const n = Math.min(12, Math.ceil((ratesRef.current[zone] ?? 0) / 2));
        for (let i = 0; i < n; i += 1) {
          const p = placeOf(zone, `${zone}-${now}-${i}-${Math.random()}`);
          fresh.push({ id: (next.current += 1), x: p.x, y: p.y });
        }
      }
      setSparks((old) => [...old.filter((s) => s.id > now - 200), ...fresh].slice(-220));
    }, 600);
    return () => window.clearInterval(timer);
  }, [on]);
  return sparks;
}

/**
 * Hartă live (the demo's map): the Rețele Electrice distribution areas on a map of Romania, coloured by the average
 * consumption of the current hour, with the outages (pulsing), the anomalous meters and the readings arriving live.
 * Data: GET /meters/counters, /statistics/grid-insights, /files?category=fault_records, /meters/simulator.
 * Outages and meters carry a zone, not a county: each is drawn on a stable county of its zone.
 */
export function LiveMapScreen() {
  const live = useLiveRefresh();
  const counters = useMeterCounters();
  const grid = useGrid(live);
  const faults = useFaults(live);
  const mode = useSimulatorMode(live);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ consumption: true, faults: true, anomalies: true, readings: true });
  const [focus, setFocus] = useState<Zone | null>(null);

  const rates = useMemo(() => {
    const r: Record<Zone, number> = { muntenia: 0, banat: 0, dobrogea: 0 };
    for (const z of counters.data?.byZone ?? []) r[z.zone] = z.ratePerS;
    return r;
  }, [counters.data]);
  const sparks = useSparks(rates, layers.readings && live);

  const hour = new Date().getHours();
  const consumption = useMemo(() => {
    const rows = grid.data?.consumptionByHourZone ?? [];
    const out: Record<Zone, number | null> = { muntenia: null, banat: null, dobrogea: null };
    for (const zone of ZONES) {
      const own = rows.filter((r) => r.zone === zone);
      const now = own.find((r) => r.hour === hour);
      out[zone] = now ? now.avgKwh : own.length ? own.reduce((s, r) => s + r.avgKwh, 0) / own.length : null;
    }
    return out;
  }, [grid.data, hour]);
  const maxKwh = Math.max(0.0001, ...ZONES.map((z) => consumption[z] ?? 0));
  const fillOf = (c: County) => {
    if (!c.zone) return 'var(--fg-surface-sunken)';
    if (!layers.consumption) return 'var(--fg-seq-1)';
    const v = consumption[c.zone];
    if (v === null) return 'var(--fg-seq-1)';
    return SEQ[Math.min(4, Math.max(1, Math.round((v / maxKwh) * 4)))] as string;
  };

  const faultsByZone = useMemo(() => {
    const out: Record<Zone, number> = { muntenia: 0, banat: 0, dobrogea: 0 };
    for (const f of grid.data?.faultsByZone ?? []) out[f.zone] = f.count;
    return out;
  }, [grid.data]);
  const anomaliesByZone = useMemo(() => {
    const out: Record<Zone, number> = { muntenia: 0, banat: 0, dobrogea: 0 };
    for (const a of grid.data?.anomalies ?? []) out[a.zone] += 1;
    return out;
  }, [grid.data]);

  const faultMarks = (faults.data ?? []).filter((f): f is FaultFile & { zone: Zone } => !!f.zone && ZONES.includes(f.zone));
  const anomalyMarks = grid.data?.anomalies ?? [];
  const storm = !!mode.data && mode.data !== 'normal';
  const c = counters.data;

  const toggle = (l: Layer) => setLayers((s) => ({ ...s, [l]: !s[l] }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold">{t.title}</h2>
        <span className={`map-live-pill ${storm ? 'map-live-pill-storm' : ''}`}>
          <span className="map-live-dot" aria-hidden="true" />
          {storm ? t.storm : t.live}
        </span>
        <p className="text-sm text-[var(--fg-ink-2)]">{t.subtitle}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="relative overflow-hidden p-3">
          <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label={t.layers}>
            {(['consumption', 'faults', 'anomalies', 'readings'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={layers[l]}
                onClick={() => toggle(l)}
                className={`map-chip ${layers[l] ? 'map-chip-on' : ''}`}
              >
                <span className={`map-chip-dot map-chip-dot-${l}`} aria-hidden="true" />
                {t.layer[l]}
              </button>
            ))}
          </div>
          <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="h-auto w-full" role="img" aria-label={t.mapLabel}>
            <defs>
              <filter id="map-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {COUNTIES.map((county) => (
              <path
                key={county.id}
                d={county.d}
                fill={fillOf(county)}
                stroke={county.zone ? 'var(--fg-surface)' : 'var(--fg-line)'}
                strokeWidth={county.zone && focus === county.zone ? 3 : 1}
                className={county.zone ? 'map-county-active' : undefined}
                opacity={focus && county.zone && county.zone !== focus ? 0.45 : 1}
                onMouseEnter={() => county.zone && setFocus(county.zone)}
                onMouseLeave={() => setFocus(null)}
              >
                <title>
                  {county.zone
                    ? t.countyTitle(county.name, ro.live.zones[county.zone] ?? county.zone, consumption[county.zone])
                    : t.countyOutside(county.name)}
                </title>
              </path>
            ))}
            {layers.readings &&
              sparks.map((s) => <circle key={s.id} cx={s.x} cy={s.y} r={3.4} className="map-spark" filter="url(#map-glow)" />)}
            {layers.anomalies &&
              anomalyMarks.slice(0, 40).map((a, i) => {
                const p = placeOf(a.zone, a.meterId);
                return (
                  <g key={`${a.meterId}-${i}`}>
                    <rect x={p.x - 4} y={p.y - 4} width={8} height={8} transform={`rotate(45 ${p.x} ${p.y})`} className="map-anomaly">
                      <title>{t.anomalyTitle(a.meterId, a.type, a.value)}</title>
                    </rect>
                  </g>
                );
              })}
            {layers.faults &&
              faultMarks.map((f) => {
                const p = placeOf(f.zone, f.id);
                const fresh = Date.now() - Date.parse(f.createdAt) < 10 * 60_000;
                return (
                  <Link key={f.id} href={`/files/${f.id}`}>
                    <circle cx={p.x} cy={p.y} r={fresh ? 9 : 6} className="map-fault-pulse" />
                    <circle cx={p.x} cy={p.y} r={fresh ? 6 : 4} className="map-fault" filter="url(#map-glow)">
                      <title>{t.faultTitle(f.displayName, p.county.name, ago(f.createdAt))}</title>
                    </circle>
                  </Link>
                );
              })}
            {ZONES.map((zone) => {
              const list = COUNTIES_OF[zone];
              const cx = list.reduce((s, k) => s + k.cx, 0) / list.length;
              const cy = list.reduce((s, k) => s + k.cy, 0) / list.length;
              const pos = LABEL_AT[zone];
              const x = pos.anchor === 'end' ? Math.min(...list.map((k) => k.cx)) + pos.dx : cx + pos.dx;
              const y = pos.anchor === 'end' ? cy + pos.dy : Math.min(...list.map((k) => k.cy)) + pos.dy;
              return (
                <g key={zone} className="map-zone-label" pointerEvents="none">
                  <text x={x} y={y} textAnchor={pos.anchor} className="map-zone-name">
                    {(ro.live.zones[zone] ?? zone).toUpperCase()}
                  </text>
                  <text x={x} y={y + 22} textAnchor={pos.anchor} className="map-zone-rate">
                    {t.rate(rates[zone])}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-[var(--fg-ink-2)]">
            <span className="flex items-center gap-1">
              {SEQ.slice(1).map((s) => (
                <span key={s} className="inline-block h-3 w-5" style={{ background: s }} />
              ))}
              <span className="ml-1">{t.legendConsumption}</span>
            </span>
            <span>{t.legendNote}</span>
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--fg-ink-2)]">{t.totals}</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{t.rate(c?.ratePerS ?? 0)}</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <div className="text-lg font-bold tabular-nums">{formatInt(c?.unique ?? 0)}</div>
                {t.unique}
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-[var(--fg-ok-ink)]">{c?.lost ?? 0}</div>
                {t.lost}
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">{formatInt(c?.duplicatesRejected ?? 0)}</div>
                {t.duplicates}
              </div>
            </div>
          </Card>

          {ZONES.map((zone) => (
            <Card
              key={zone}
              className={`p-4 transition-shadow ${focus === zone ? 'map-zone-card-focus' : ''}`}
              onMouseEnter={() => setFocus(zone)}
              onMouseLeave={() => setFocus(null)}
            >
              <div className="flex items-baseline justify-between">
                <div className="font-bold">{ro.live.zones[zone] ?? zone}</div>
                <div className="text-xs text-[var(--fg-ink-2)]">{COUNTIES_OF[zone].map((k) => k.name).join(', ')}</div>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
                <div>
                  <div className="text-base font-bold tabular-nums">{rates[zone].toLocaleString('ro-RO', { maximumFractionDigits: 1 })}</div>
                  {t.perSecond}
                </div>
                <div>
                  <div className="text-base font-bold tabular-nums">{consumption[zone]?.toFixed(2).replace('.', ',') ?? '—'}</div>
                  {t.avgKwh}
                </div>
                <div>
                  <div className="text-base font-bold tabular-nums text-[var(--fg-crit-ink)]">{faultsByZone[zone]}</div>
                  {t.faults24h}
                </div>
                <div>
                  <div className="text-base font-bold tabular-nums text-[var(--fg-warn-ink)]">{anomaliesByZone[zone]}</div>
                  {t.anomalies}
                </div>
              </div>
            </Card>
          ))}

          {grid.data?.interpretation.text && (
            <Card className="p-4 text-sm">
              <div className="mb-1 text-xs uppercase tracking-wide text-[var(--fg-ink-2)]">{t.insight}</div>
              <p>{grid.data.interpretation.text}</p>
              {grid.data.interpretation.recommendation && (
                <p className="mt-2 font-semibold">{grid.data.interpretation.recommendation}</p>
              )}
            </Card>
          )}

          <Card className="p-4 text-sm">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--fg-ink-2)]">{t.latestFaults}</div>
            {faultMarks.length === 0 && <p className="text-[var(--fg-ink-2)]">{t.noFaults}</p>}
            <ul className="flex flex-col gap-1.5">
              {faultMarks.slice(0, 6).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <Link href={`/files/${f.id}`} className="truncate">
                    <span className="map-fault-bullet" aria-hidden="true" /> {placeOf(f.zone, f.id).county.name} · {f.displayName}
                  </Link>
                  <span className="shrink-0 text-xs text-[var(--fg-ink-2)]">{ago(f.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
