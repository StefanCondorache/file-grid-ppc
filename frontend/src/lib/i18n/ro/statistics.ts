import type { StatsCategoryId, StorageId, Zone } from '@/features/statistics/contract';

const NBSP = ' ';
const LAST_DAY = `ultimele 24${NBSP}h`;

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const quote = (label: string) => `„${label}”`;
const paren = (text: string | null) => (text ? ` (${text})` : '');

/** Romanian list: "a", "a și b", "a, b și c". */
function and(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} și ${items[items.length - 1]}`;
}

/**
 * How the UI names a category: `label` on charts and tables, `size` its typical file size (brief table 2.1), and in
 * sentences `subject` with the article ("avariile") or `bare` after "pentru" ("avarii").
 */
const category: Readonly<Record<StatsCategoryId, { label: string; size: string; subject: string; bare: string }>> = {
  meter_readings: { label: 'Citiri contoare', size: `1–50${NBSP}KB`, subject: 'citirile de contor', bare: 'citiri de contor' },
  fault_records: { label: 'Avarii', size: `1–10${NBSP}MB`, subject: 'avariile', bare: 'avarii' },
  connection_documents: { label: 'Racordări', size: `0,1–10${NBSP}MB`, subject: 'documentele de racordare', bare: 'documente de racordare' },
  drone_videos: { label: 'Video dronă', size: `0,1–1${NBSP}GB+`, subject: 'video-urile de dronă', bare: 'video-uri de dronă' },
};

const storage: Readonly<Record<StorageId, string>> = { s3: 'S3', ftp: 'FTP', db: 'DB' };

/** `definite` follows "decât" and "începând cu" ("decât Banatul"); `label` follows "în" ("în Banat"). */
const zone: Readonly<Record<Zone, { label: string; definite: string }>> = {
  muntenia: { label: 'Muntenia', definite: 'Muntenia' },
  banat: { label: 'Banat', definite: 'Banatul' },
  dobrogea: { label: 'Dobrogea', definite: 'Dobrogea' },
};

/**
 * Statistics copy (slice 6f) and the OQ-7 interpretation templates the UI uses when the backend sends only `facts`.
 * Every number arrives already formatted (`features/statistics/interpret.ts`); the templates only place the words.
 */
export const statistics = {
  category,
  storage,
  zone,
  and,
  /** The `/statistics` screen (SC-08). */
  screen: {
    title: 'Ce ne spun datele',
    lead: 'Răspunsuri pentru decizii, nu doar grafice. Fiecare bloc are o interpretare și o recomandare.',
    refresh: 'Actualizează',
  },
  /** The two labelled periods S2 compares (FE-12: chosen from a list, never free dates). */
  periods: {
    legend: 'Perioadele comparate',
    a: 'Perioada A',
    b: 'Perioada B',
    group: { normal: 'Zile normale', peak: 'Zile de vârf' },
    choose: 'Alege o perioadă',
    none: 'Nu există încă perioade etichetate.',
  },
  /** The two blocks under every statistics chart (FE-10). */
  insight: { interpretation: 'Interpretare', recommendation: 'Recomandare' },
  /** S1 · the chart, its tag and its table. */
  fit: {
    eyebrow: 'S1',
    title: 'Ce storage se potrivește fiecărei categorii?',
    caption: 'p95 la scriere pe fiecare storage, în ultimele 7 zile',
    note: (operations: string) => `Bare mai scurte = mai bine; fiecare categorie are scara ei. Măsurat pe ${operations}.`,
    recommended: (storage: string) => `Recomandat: ${storage}`,
    notMeasured: 'nemăsurat',
    empty: 'Încă nu există măsurători pe storage-uri.',
    column: {
      category: 'Categorie',
      storage: 'Storage',
      samples: 'Operații',
      p50: 'p50',
      p95: 'p95',
      throughput: 'Debit',
      errorRate: 'Erori',
      recommended: 'Recomandat',
    },
    yes: 'da',
    no: 'nu',
  },
  /** S2 · the dumbbell chart, its legend and its table. */
  comparison: {
    eyebrow: 'S2',
    title: 'Zi normală vs. zi de vârf',
    caption: (axisMax: string) => `Timp de scriere (p95) pe categorie · axa 0–${axisMax}`,
    legend: 'Legendă',
    /** Legend entry: "Perioada A: Zi normală · 12 nov". */
    period: (name: string, label: string) => `${name}: ${label}`,
    /** Table header: "Perioada A (Zi normală · 12 nov)". */
    column: (name: string, label: string) => `${name} (${label})`,
    /** What the dumbbell draws, in words for screen readers. */
    row: (p: { a: string; b: string; delta: string | null }) => `Perioada A: ${p.a}; perioada B: ${p.b}${paren(p.delta)}.`,
    notMeasured: 'nemăsurat',
    noDelta: 'nu se poate calcula',
    waiting: 'Alegeți perioadele de comparat.',
    waitingBody: 'S2 compară o zi normală cu o zi de vârf. Pornirea unei furtuni din camera de demo înregistrează o perioadă de vârf.',
    empty: 'Nu există măsurători ale timpului de scriere în perioadele alese.',
    metric: { p95Ms: 'p95 la scriere', opsPerS: 'Operații/s', errorRate: 'Rata de erori', volume: 'Volum' },
    readings: { one: 'o citire', few: '# citiri', other: '# de citiri' },
    columns: { category: 'Categorie', metric: 'Indicator', delta: 'Diferență' },
  },
  /** S1 · storage fit, one category. */
  s1: {
    faster: (p: { subject: string; times: string; fast: string; slow: string; fastP95: string; slowP95: string }) =>
      `${cap(p.subject)} se scriu de ${p.times}× mai repede pe ${p.fast} decât pe ${p.slow} (p95 ${p.fastP95} față de ${p.slowP95}).`,
    asFast: (p: { subject: string; first: string; second: string; firstP95: string; secondP95: string }) =>
      `${cap(p.subject)} se scriu la fel de repede pe ${p.first} și pe ${p.second} (p95 ${p.firstP95} și ${p.secondP95}).`,
    onlyOne: (p: { subject: string; storage: string; p95: string; operations: string }) =>
      `${cap(p.subject)} au fost măsurate doar pe ${p.storage}: p95 ${p.p95} în ${p.operations}.`,
    operations: { one: 'o operație', few: '# operații', other: '# de operații' },
    notEnough: 'Încă nu sunt destule măsurători pentru această categorie.',
    move: (p: { subject: string; current: string; recommended: string }) =>
      `Politica scrie acum ${p.subject} pe ${p.current}; mutați-le pe ${p.recommended}.`,
    keepAndWatch: (p: { subject: string; recommended: string; faster: string }) =>
      `Păstrați ${p.subject} pe ${p.recommended} și verificați dacă ${p.faster} rămâne mai rapid în măsurători.`,
    keepFaster: (p: { subject: string; recommended: string; times: string; slow: string }) =>
      `Păstrați ${p.subject} pe ${p.recommended}, unde p95 este de ${p.times}× mai mic decât pe ${p.slow}.`,
    keep: (p: { subject: string; recommended: string }) => `Păstrați ${p.subject} pe ${p.recommended}.`,
  },
  /** S2 · period A (normal) vs period B (peak). */
  s2: {
    grew: (p: { period: string; subject: string; load: string; from: string; to: string; delta: string | null }) =>
      `În ${quote(p.period)}, ${p.subject} au crescut de ${p.load}×, iar p95 la scriere a urcat de la ${p.from} la ${p.to}${paren(p.delta)}.`,
    slower: (p: { period: string; bare: string; from: string; to: string; delta: string | null }) =>
      `În ${quote(p.period)}, p95 la scriere pentru ${p.bare} a urcat de la ${p.from} la ${p.to}${paren(p.delta)}.`,
    noneSlower: (p: { a: string; b: string }) => `În ${quote(p.b)}, nicio categorie nu a încetinit față de ${quote(p.a)}.`,
    isolated: 'Celelalte categorii și-au păstrat timpii de răspuns: compartimentele (bulkhead) le-au izolat de vârf.',
    notIsolated: (slowed: string | null) =>
      `${slowed ? `Au încetinit și ${slowed}` : 'Și alte categorii au încetinit'}: compartimentele nu au izolat complet vârful.`,
    scaleOut: (bare: string) =>
      `Păstrați limitele de concurență din politici, care au izolat vârful, și adăugați instanțe de backend pentru ${bare} în zilele de vârf.`,
    raiseConcurrency:
      'Măriți limita de concurență în politicile categoriilor care au încetinit sau adăugați instanțe de backend.',
    noChange: 'Nu sunt necesare schimbări: timpii de răspuns au rămas stabili.',
  },
  /** S3 · grid insights over the last 24 h. */
  s3: {
    faults: (p: { zone: string; count: string | null; total: string | null; times: string | null; versus: string | null }) =>
      `${p.zone} are cele mai multe avarii în ${LAST_DAY}`
      + (p.count && p.total ? `: ${p.count} din ${p.total}` : '')
      + (p.times && p.versus ? `, de ${p.times}× mai multe decât ${p.versus}` : '')
      + '.',
    noFaults: `Nu sunt avarii raportate în ${LAST_DAY}.`,
    consumption: (p: { hour: string; zone: string | null; kwh: string | null; anomalous: string | null }) =>
      `Consumul atinge vârful la ora ${p.hour}${p.zone ? `, în ${p.zone}` : ''}`
      + (p.kwh ? ` (${p.kwh} în medie pe citire)` : '')
      + (p.anomalous ? `, iar ${p.anomalous}.` : ', fără citiri anormale.'),
    anomalous: { one: 'o citire este anormală', few: '# citiri sunt anormale', other: '# de citiri sunt anormale' },
    anomalousOnly: (anomalous: string) => `${cap(anomalous)} în ${LAST_DAY}.`,
    noReadings: `Nu sunt citiri de contor în ${LAST_DAY}.`,
    checkMeters: (zoneFirst: string | null) =>
      `Verificați contoarele cu citiri anormale${zoneFirst ? `, începând cu ${zoneFirst}` : ''}: pot indica fraude sau defecte.`,
    inspect: (zoneLabel: string) => `Prioritizați inspecțiile cu drona în ${zoneLabel}, zona cu cele mai multe avarii.`,
    nothing: `Nu este nevoie de acțiuni: nu sunt avarii sau citiri anormale în ${LAST_DAY}.`,
  },
} as const;
