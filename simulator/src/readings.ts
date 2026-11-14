// Meter fleet and reading generation. A reading id is "<meterId>:<sequence>": globally unique and stable,
// so a retried or re-sent reading carries the same id and the backend can deduplicate it.

export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const;
export type Zone = (typeof ZONES)[number];
export type Origin = 'simulator' | 'storm';
export type Rng = () => number;

export interface Reading {
  readonly readingId: string;
  readonly meterId: string;
  readonly zone: Zone;
  readonly readingTime: string;
  readonly kwh: number;
  readonly sequence: number;
  readonly origin: Origin;
}

const ZONE_SHARES: Readonly<Record<Zone, number>> = { muntenia: 0.5, banat: 0.3, dobrogea: 0.2 };
const ZONE_CODES: Readonly<Record<Zone, string>> = { muntenia: 'MUN', banat: 'BAN', dobrogea: 'DOB' };

const INTERVAL_HOURS = 0.25; // one reading = 15 minutes of consumption
const NOISE_SIGMA = 0.1;
export const ANOMALY_RATIO = 0.005;
const COMMERCIAL_SHARE = 0.15;
const TIME_ZONE = 'Europe/Bucharest';

/** Splits `total` meters over the zones by share (largest remainder, so the counts always add up). */
export function zoneCounts(total: number): Record<Zone, number> {
  const exact = ZONES.map((zone) => ({ zone, value: total * ZONE_SHARES[zone] }));
  const counts = Object.fromEntries(exact.map(({ zone, value }) => [zone, Math.floor(value)])) as Record<Zone, number>;
  let remaining = total - ZONES.reduce((sum, zone) => sum + counts[zone], 0);
  const byRemainder = [...exact].sort((a, b) => (b.value % 1) - (a.value % 1));
  for (const { zone } of byRemainder) {
    if (remaining <= 0) break;
    counts[zone] += 1;
    remaining -= 1;
  }
  return counts;
}

export function meterId(zone: Zone, index: number): string {
  return `RO-${ZONE_CODES[zone]}-${String(index).padStart(6, '0')}`;
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function bump(hour: number, center: number, width: number, height: number): number {
  const raw = Math.abs(hour - center);
  const distance = Math.min(raw, 24 - raw); // the day wraps around midnight
  return height * Math.exp(-(distance * distance) / (2 * width * width));
}

/** Relative load over the day: night trough ~0.45, morning peak ~07:30, evening peak ~19:30. */
export function dailyProfile(hour: number): number {
  return 0.45 + bump(hour, 7.5, 1.2, 0.75) + bump(hour, 13, 2.5, 0.35) + bump(hour, 19.5, 1.8, 1.15);
}

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});
let cachedMinute = Number.NaN;
let cachedHour = 0;

/** Fractional local hour in Romania (cached per minute: called for every reading). */
export function localHour(epochMs: number): number {
  const minute = Math.floor(epochMs / 60_000);
  if (minute !== cachedMinute) {
    const parts = hourFormat.formatToParts(new Date(epochMs));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    cachedMinute = minute;
    cachedHour = h + m / 60;
  }
  return cachedHour;
}

export function roundKwh(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : 0;
}

/** kWh used over one 15-minute interval: base load x daily profile x noise, with rare spikes or zeros. */
export function consumptionKwh(baseKw: number, hour: number, rng: Rng): number {
  const noise = Math.max(0, 1 + NOISE_SIGMA * gaussian(rng));
  const normal = baseKw * dailyProfile(hour) * INTERVAL_HOURS * noise;
  if (rng() >= ANOMALY_RATIO) return roundKwh(normal);
  return rng() < 0.5 ? roundKwh(normal * (5 + 5 * rng())) : 0;
}

interface Meter {
  readonly id: string;
  readonly zone: Zone;
  readonly baseKw: number;
  nextSequence: number;
}

function baseLoadKw(rng: Rng): number {
  return rng() < COMMERCIAL_SHARE ? 0.8 + 2.5 * rng() : 0.12 + 0.45 * rng();
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export interface FleetOptions {
  readonly meterCount: number;
  /** First sequence number of every meter; the startup time in ms keeps ids unique across restarts. */
  readonly sequenceBase: number;
  readonly rng?: Rng;
}

export class MeterFleet {
  readonly #meters: Meter[];
  readonly #rng: Rng;
  #cursor = 0;

  constructor(options: FleetOptions) {
    this.#rng = options.rng ?? Math.random;
    const counts = zoneCounts(options.meterCount);
    const meters = ZONES.flatMap((zone) =>
      Array.from({ length: counts[zone] }, (_, i) => ({
        id: meterId(zone, i + 1),
        zone,
        baseKw: baseLoadKw(this.#rng),
        nextSequence: options.sequenceBase,
      })),
    );
    this.#meters = shuffle(meters, this.#rng); // round-robin over a shuffled order interleaves the zones
  }

  get size(): number {
    return this.#meters.length;
  }

  /** Next reading, round-robin over the meters; each meter's sequence grows by one per reading. */
  next(nowMs: number, origin: Origin): Reading {
    const meter = this.#meters[this.#cursor] as Meter;
    this.#cursor = (this.#cursor + 1) % this.#meters.length;
    const sequence = meter.nextSequence;
    meter.nextSequence += 1;
    return {
      readingId: `${meter.id}:${sequence}`,
      meterId: meter.id,
      zone: meter.zone,
      readingTime: new Date(nowMs).toISOString(),
      kwh: consumptionKwh(meter.baseKw, localHour(nowMs), this.#rng),
      sequence,
      origin,
    };
  }
}

/** Small seeded PRNG (mulberry32) for reproducible tests. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
