import { describe, expect, it } from 'vitest';
import type {
  ComparisonMetric,
  ComparisonRow,
  GridInsights,
  HourlyConsumption,
  MeterAnomaly,
  Period,
  PeriodComparison,
  StatsCategoryId,
  StorageFitItem,
  StorageId,
  StoragePerformance,
  Zone,
} from './contract';
import { interpretS1, interpretS2, interpretS3 } from './interpret';

/** Expected copy is written with `~` where Romanian typography puts a no-break space (U+00A0). */
const ro = (text: string) => text.replace(/~/g, ' ');

const perf = (storage: StorageId, samples: number, p95Ms: number | null): StoragePerformance => ({
  storage,
  samples,
  p50Ms: p95Ms === null ? null : Math.round(p95Ms / 2),
  p95Ms,
  throughputBps: null,
  errorRate: samples > 0 ? 0 : null,
});

/** The 6f.1 mock's fault records: S3 p95 0,6 s, FTP 1,8 s, DB never used. */
function faults(over: Partial<StorageFitItem> = {}, facts: StorageFitItem['interpretation']['facts'] = {
  primaryStorage: 's3', fastest: 's3', runnerUp: 'ftp', speedup: 3,
}): StorageFitItem {
  return {
    category: 'fault_records',
    storages: [perf('s3', 1240, 600), perf('ftp', 96, 1800), perf('db', 0, null)],
    recommendedStorage: 's3',
    interpretation: { text: null, recommendation: null, facts },
    ...over,
  };
}

const NORMAL: Period = {
  id: 'p-normal', label: 'Zi normală · 12 nov', kind: 'normal', origin: 'seed',
  start: '2026-11-11T22:00:00.000Z', end: '2026-11-12T21:59:59.000Z',
};
const STORM: Period = {
  id: 'p-storm', label: 'Furtună · 14 nov 15:33', kind: 'peak', origin: 'storm',
  start: '2026-11-14T13:33:00.000Z', end: '2026-11-14T13:48:00.000Z',
};

type Pair = readonly [number | null, number | null];
type Metrics = Partial<Record<ComparisonMetric, Pair>>;

/** The 6f.1 mock's normal day vs storm: faults ×10 load and p95 0,6 s → 3,4 s, the rest flat. */
const STORM_METRICS: Record<StatsCategoryId, Metrics> = {
  meter_readings: { p95Ms: [42, 45], opsPerS: [50, 52] },
  fault_records: { p95Ms: [600, 3400], opsPerS: [0.01, 0.1] },
  connection_documents: { p95Ms: [250, 265], opsPerS: [0.002, 0.002] },
  drone_videos: { p95Ms: [1400, 1480], opsPerS: [0.0005, 0.0005] },
};

function rows(metrics: Record<StatsCategoryId, Metrics>): ComparisonRow[] {
  return (Object.keys(metrics) as StatsCategoryId[]).flatMap((category) =>
    (Object.entries(metrics[category]) as [ComparisonMetric, Pair][]).map(([metric, [a, b]]) => ({
      category,
      metric,
      a,
      b,
      deltaPct: a !== null && b !== null && a !== 0 ? Math.round(((b - a) / a) * 1000) / 10 : null,
    })),
  );
}

function comparison(
  metrics: Record<StatsCategoryId, Metrics> = STORM_METRICS,
  facts: PeriodComparison['interpretation']['facts'] = {
    factor: 10, isolated: true, mostAffected: 'fault_records', mostAffectedDeltaPct: 466.7,
  },
): PeriodComparison {
  return { periodA: NORMAL, periodB: STORM, rows: rows(metrics), interpretation: { text: null, recommendation: null, facts } };
}

const anomaly = (meterId: string, zone: Zone, type: MeterAnomaly['type']): MeterAnomaly => ({
  meterId, zone, type, detectedAt: '2026-11-14T17:45:00.000Z', value: type === 'silent' ? null : 0, fileId: null,
});

const consumption: HourlyConsumption[] = [
  { zone: 'muntenia', hour: 3, avgKwh: 0.189 },
  { zone: 'muntenia', hour: 19, avgKwh: 0.504 },
  { zone: 'banat', hour: 19, avgKwh: 0.432 },
  { zone: 'dobrogea', hour: 19, avgKwh: 0.468 },
];

/** The 6f.1 mock's last 24 h: faults per region, the 19:00 peak in Muntenia and 6 anomalous readings. */
function grid(over: Partial<GridInsights> = {}, facts: GridInsights['interpretation']['facts'] = {
  topFaultZone: 'muntenia', peakHour: 19, peakZone: 'muntenia', anomalies: 6, faultsTotal: 75,
}): GridInsights {
  return {
    faultsByZone: [
      { zone: 'muntenia', county: null, count: 38 },
      { zone: 'banat', county: null, count: 14 },
      { zone: 'dobrogea', county: null, count: 23 },
    ],
    consumptionByHourZone: consumption,
    anomalies: [
      anomaly('RO-MUN-000412', 'muntenia', 'spike'),
      anomaly('RO-DOB-000087', 'dobrogea', 'zero'),
      anomaly('RO-BAN-000215', 'banat', 'negative'),
      anomaly('RO-MUN-001203', 'muntenia', 'silent'),
      anomaly('RO-DOB-000311', 'dobrogea', 'spike'),
      anomaly('RO-MUN-000058', 'muntenia', 'zero'),
    ],
    interpretation: { text: null, recommendation: null, facts },
    ...over,
  };
}

describe('statistics interpretations (OQ-7)', () => {
  it('templates S1 from facts: faults on S3 at 0,6 s vs FTP at 1,8 s', () => {
    expect(interpretS1(faults())).toEqual({
      text: ro('Avariile se scriu de 3× mai repede pe S3 decât pe FTP (p95 0,6~s față de 1,8~s).'),
      recommendation: 'Păstrați avariile pe S3, unde p95 este de 3× mai mic decât pe FTP.',
    });
  });

  it('lets the backend text win when present', () => {
    const backend = { text: 'Text de la backend.', recommendation: 'Recomandare de la backend.' };
    const s1 = faults();
    const s2 = comparison();
    const s3 = grid();

    expect(interpretS1({ ...s1, interpretation: { ...s1.interpretation, ...backend } })).toEqual(backend);
    expect(interpretS2({ ...s2, interpretation: { ...s2.interpretation, ...backend } })).toEqual(backend);
    expect(interpretS3({ ...s3, interpretation: { ...s3.interpretation, ...backend } })).toEqual(backend);

    // Field by field: the real backend leaves `recommendation` null when nothing needs changing.
    expect(interpretS1({ ...s1, interpretation: { ...s1.interpretation, text: backend.text } })).toEqual({
      text: backend.text,
      recommendation: 'Păstrați avariile pe S3, unde p95 este de 3× mai mic decât pe FTP.',
    });
    // Blank text counts as absent.
    expect(interpretS1({ ...s1, interpretation: { ...s1.interpretation, text: '  ' } }).text).toMatch(/^Avariile se scriu/);
  });

  it('formats numbers the Romanian way', () => {
    const drones: StorageFitItem = {
      category: 'drone_videos',
      storages: [perf('s3', 64, 1400), perf('ftp', 22, 2100), perf('db', 0, null)],
      recommendedStorage: 's3',
      interpretation: { text: null, recommendation: null, facts: { primaryStorage: 's3', fastest: 's3', runnerUp: 'ftp', speedup: 1.5 } },
    };
    expect(interpretS1(drones).text).toBe(ro('Video-urile de dronă se scriu de 1,5× mai repede pe S3 decât pe FTP (p95 1,4~s față de 2,1~s).'));

    const meters: StorageFitItem = {
      category: 'meter_readings',
      storages: [perf('s3', 0, null), perf('ftp', 0, null), perf('db', 60_480, 42)],
      recommendedStorage: 'db',
      interpretation: { text: null, recommendation: null, facts: { primaryStorage: 'db', fastest: 'db', runnerUp: null, speedup: null } },
    };
    expect(interpretS1(meters).text).toBe(ro('Citirile de contor au fost măsurate doar pe DB: p95 42~ms în 60~480 de operații.'));

    expect(interpretS2(comparison()).text).toContain(ro('de la 0,6~s la 3,4~s (+467~%)'));

    const busy = grid({
      faultsByZone: [
        { zone: 'muntenia', county: null, count: 1284 },
        { zone: 'banat', county: null, count: 514 },
        { zone: 'dobrogea', county: null, count: 702 },
      ],
    }, { topFaultZone: 'muntenia', peakHour: 19, peakZone: 'muntenia', anomalies: 6, faultsTotal: 2500 });
    expect(interpretS3(busy).text).toContain(ro('Muntenia are cele mai multe avarii în ultimele 24~h: 1~284 din 2~500, de 2,5× mai multe decât Banatul.'));
    expect(interpretS3(busy).text).toContain(ro('(0,50~kWh în medie pe citire)'));
  });
});

describe('S1 templates', () => {
  it('derives the runner-up and the speedup from the measurements when facts name only the fastest (real backend)', () => {
    expect(interpretS1(faults({}, { primaryStorage: 's3', fastest: 's3' })).text).toBe(
      ro('Avariile se scriu de 3× mai repede pe S3 decât pe FTP (p95 0,6~s față de 1,8~s).'),
    );
  });

  it('recommends moving the category when the policy writes it elsewhere, or watching a faster storage', () => {
    expect(interpretS1(faults({}, { primaryStorage: 'ftp', fastest: 's3', runnerUp: 'ftp', speedup: 3 })).recommendation).toBe(
      'Politica scrie acum avariile pe FTP; mutați-le pe S3.',
    );
    expect(interpretS1(faults({ recommendedStorage: 'ftp' }, { primaryStorage: 'ftp', fastest: 's3', runnerUp: 'ftp', speedup: 3 })).recommendation).toBe(
      'Păstrați avariile pe FTP și verificați dacă S3 rămâne mai rapid în măsurători.',
    );
  });

  it('says when the storages are about as fast, or when there are not enough measurements', () => {
    const even = faults({ storages: [perf('s3', 1240, 600), perf('ftp', 96, 630), perf('db', 0, null)] }, { primaryStorage: 's3', fastest: 's3' });
    expect(interpretS1(even)).toEqual({
      text: ro('Avariile se scriu la fel de repede pe S3 și pe FTP (p95 0,6~s și 0,63~s).'),
      recommendation: 'Păstrați avariile pe S3.',
    });

    const empty = faults({ storages: [perf('s3', 3, 600), perf('ftp', 0, null), perf('db', 0, null)] }, { primaryStorage: 's3', fastest: null });
    expect(interpretS1(empty)).toEqual({
      text: 'Încă nu sunt destule măsurători pentru această categorie.',
      recommendation: 'Păstrați avariile pe S3.',
    });
  });
});

describe('S2 templates', () => {
  it('names the stormed category, its load, its p95 change and the bulkhead isolation', () => {
    expect(interpretS2(comparison())).toEqual({
      text: ro(
        'În „Furtună · 14 nov 15:33”, avariile au crescut de 10×, iar p95 la scriere a urcat de la 0,6~s la 3,4~s (+467~%). '
        + 'Celelalte categorii și-au păstrat timpii de răspuns: compartimentele (bulkhead) le-au izolat de vârf.',
      ),
      recommendation: 'Păstrați limitele de concurență din politici, care au izolat vârful, și adăugați instanțe de backend pentru avarii în zilele de vârf.',
    });
  });

  it('reads the stormed category from the rows when facts carry only factor and isolated (real backend)', () => {
    // The real backend's factor is the meter rate ratio; it must not be credited to the faults.
    expect(interpretS2(comparison(STORM_METRICS, { factor: 1, isolated: true })).text).toMatch(
      /^În „Furtună · 14 nov 15:33”, avariile au crescut de 10×, iar p95 la scriere a urcat/,
    );
  });

  it('flags the other categories that slowed when the peak was not isolated', () => {
    const leaky = {
      ...STORM_METRICS,
      connection_documents: { p95Ms: [250, 900], opsPerS: [0.002, 0.002] },
      drone_videos: { p95Ms: [1400, 2600], opsPerS: [0.0005, 0.0005] },
    } satisfies Record<StatsCategoryId, Metrics>;
    expect(interpretS2(comparison(leaky, { factor: 10, isolated: false, mostAffected: 'fault_records', mostAffectedDeltaPct: 466.7 }))).toEqual({
      text: ro(
        'În „Furtună · 14 nov 15:33”, avariile au crescut de 10×, iar p95 la scriere a urcat de la 0,6~s la 3,4~s (+467~%). '
        + 'Au încetinit și documentele de racordare și video-urile de dronă: compartimentele nu au izolat complet vârful.',
      ),
      recommendation: 'Măriți limita de concurență în politicile categoriilor care au încetinit sau adăugați instanțe de backend.',
    });
  });

  it('says nothing slowed when no p95 grew, and names the p95 alone when the load did not grow', () => {
    const flat = Object.fromEntries(
      Object.entries(STORM_METRICS).map(([c, m]) => [c, { p95Ms: [m.p95Ms![0], m.p95Ms![0]] as const, opsPerS: m.opsPerS }]),
    ) as Record<StatsCategoryId, Metrics>;
    expect(interpretS2(comparison(flat, { factor: 1, isolated: true }))).toEqual({
      text: 'În „Furtună · 14 nov 15:33”, nicio categorie nu a încetinit față de „Zi normală · 12 nov”.',
      recommendation: 'Nu sunt necesare schimbări: timpii de răspuns au rămas stabili.',
    });

    // Under the backend's isolation threshold (p95 B ≤ 1,5 × A + 50 ms): reported, but nothing to change.
    const slowOnly = { ...flat, fault_records: { p95Ms: [600, 900], opsPerS: [0.01, 0.01] } } satisfies Record<StatsCategoryId, Metrics>;
    const mild = interpretS2(comparison(slowOnly, { factor: 1, isolated: true }));
    expect(mild.text).toMatch(
      new RegExp(`^${ro('În „Furtună · 14 nov 15:33”, p95 la scriere pentru avarii a urcat de la 0,6~s la 0,9~s \\(\\+50~%\\)\\.')}`),
    );
    expect(mild.recommendation).toBe('Nu sunt necesare schimbări: timpii de răspuns au rămas stabili.');
  });
});

describe('S3 templates', () => {
  it('names the zone with most faults, the consumption peak and the anomalous readings', () => {
    expect(interpretS3(grid())).toEqual({
      text: ro(
        'Muntenia are cele mai multe avarii în ultimele 24~h: 38 din 75, de 2,7× mai multe decât Banatul. '
        + 'Consumul atinge vârful la ora 19:00, în Muntenia (0,50~kWh în medie pe citire), iar 6 citiri sunt anormale.',
      ),
      recommendation: 'Verificați contoarele cu citiri anormale, începând cu Muntenia: pot indica fraude sau defecte.',
    });
  });

  it('recommends inspections in the top fault zone when no reading is anomalous', () => {
    const calm = grid({ anomalies: [] }, { topFaultZone: 'muntenia', peakHour: 19, anomalies: 0 });
    expect(interpretS3(calm)).toEqual({
      text: ro(
        'Muntenia are cele mai multe avarii în ultimele 24~h: 38 din 75, de 2,7× mai multe decât Banatul. '
        + 'Consumul atinge vârful la ora 19:00, în Muntenia (0,50~kWh în medie pe citire), fără citiri anormale.',
      ),
      recommendation: 'Prioritizați inspecțiile cu drona în Muntenia, zona cu cele mai multe avarii.',
    });
  });

  it('says when there are no faults and no meter readings', () => {
    const quiet = grid({ faultsByZone: [], consumptionByHourZone: [], anomalies: [] }, { topFaultZone: null, peakHour: null, anomalies: 0 });
    expect(interpretS3(quiet)).toEqual({
      text: ro('Nu sunt avarii raportate în ultimele 24~h. Nu sunt citiri de contor în ultimele 24~h.'),
      recommendation: ro('Nu este nevoie de acțiuni: nu sunt avarii sau citiri anormale în ultimele 24~h.'),
    });
  });
});
