import { z } from 'zod';
import type { IntegrityState, Origin, Role } from '@/lib/api/types';
import { ROLE_ORDER } from '@/features/auth/roles';
import type { Zone } from '@/lib/upload/contract';
import type { StorageId } from '@/lib/upload/types';

/**
 * Files list filters (FE-03). The URL is the only store (frontend-architecture §1: "all filter state lives in the
 * URL"), so a list view is a shareable link. Values follow the real backend's ids (docs/api.md "Basics"); only
 * the category uses the plan's short alias in the URL (`/files?category=fault`).
 */

export const FILE_CATEGORIES = ['fault_records', 'drone_videos', 'connection_documents', 'meter_readings'] as const;
export type FileCategoryId = (typeof FILE_CATEGORIES)[number];
export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const satisfies readonly Zone[];
export const ORIGINS = ['manual', 'simulator', 'storm', 'seed'] as const satisfies readonly Origin[];
/** Meters send readings; nobody uploads one by hand (docs/api.md "Meter readings"). */
export const READING_ORIGINS = ['simulator', 'storm', 'seed'] as const satisfies readonly Origin[];
export const INTEGRITY_STATES = ['verified', 'server_verified', 'unverified', 'corrupt'] as const satisfies readonly IntegrityState[];
export const STORAGES = ['s3', 'ftp', 'db'] as const satisfies readonly StorageId[];
export const SORTS = ['-createdAt', 'createdAt', '-size', 'size'] as const;
export type FileSort = (typeof SORTS)[number];

const CATEGORY_ALIAS: Record<FileCategoryId, string> = {
  fault_records: 'fault', drone_videos: 'drone', connection_documents: 'connection', meter_readings: 'meter',
};

export type FileFilters = {
  category?: FileCategoryId;
  /** Display name search (the backend never matches personal data). */
  q?: string;
  zone?: Zone;
  /** Calendar days (YYYY-MM-DD) in Bucharest time, inclusive. */
  from?: string;
  to?: string;
  /** Username of the uploader; the demo accounts are named after their role (ADR-0022). */
  uploader?: Role;
  integrity?: IntegrityState;
  storage?: StorageId;
  origin?: Origin;
  /** "Ascunde datele generate": manual uploads only. */
  excludeGenerated?: boolean;
  sort: FileSort;
  page: number;
};

export const DEFAULT_FILTERS: FileFilters = { sort: '-createdAt', page: 1 };

const MAX_PAGE = 10_000;

const category = z.string().transform((v, ctx) => {
  const id = (FILE_CATEGORIES as readonly string[]).includes(v) ? (v as FileCategoryId) : FILE_CATEGORIES.find((c) => CATEGORY_ALIAS[c] === v);
  if (!id) ctx.addIssue({ code: 'custom', message: 'unknown category' });
  return id as FileCategoryId;
});

/** One parser per URL key; a value that fails is dropped, never shown or sent (FE-03). */
const FIELDS = {
  category,
  q: z.string().trim().min(1).max(100),
  zone: z.enum(ZONES),
  from: z.iso.date(),
  to: z.iso.date(),
  uploader: z.enum(ROLE_ORDER as [Role, ...Role[]]),
  integrity: z.enum(INTEGRITY_STATES),
  storage: z.enum(STORAGES),
  origin: z.enum(ORIGINS),
  excludeGenerated: z.enum(['1', 'true']).transform(() => true as const),
  sort: z.enum(SORTS),
  page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(MAX_PAGE)),
} satisfies Record<keyof FileFilters, z.ZodType>;

/** Order of the keys in a written URL, so equal filters always give the same link. */
const KEYS = Object.keys(FIELDS) as (keyof FileFilters)[];

/**
 * The meter readings view (SC-04 "readings table variant") lists readings, not files: `GET /meter-readings` filters
 * by meter id, zone and origin only, newest first. Its other filters are dropped, so the URL, the applied count
 * and the request never hold a filter that does nothing. Backend ask: `from`/`to` on `GET /meter-readings` (FE-11
 * "filter by meter, zone, time").
 */
export function applicableFilters(f: FileFilters): FileFilters {
  if (f.category !== 'meter_readings') return f;
  const origin = (READING_ORIGINS as readonly string[]).includes(f.origin ?? '') ? f.origin : undefined;
  const out: FileFilters = { category: f.category, sort: DEFAULT_FILTERS.sort, page: f.page };
  if (f.q !== undefined) out.q = f.q;
  if (f.zone !== undefined) out.zone = f.zone;
  if (origin !== undefined) out.origin = origin;
  return out;
}

export function parseFilters(sp: URLSearchParams): FileFilters {
  const out: Record<string, unknown> = { ...DEFAULT_FILTERS };
  for (const key of KEYS) {
    const raw = sp.get(key);
    if (raw === null) continue;
    const parsed = FIELDS[key].safeParse(raw);
    if (parsed.success) out[key] = parsed.data;
  }
  return applicableFilters(out as FileFilters);
}

export function toSearchParams(filters: FileFilters): URLSearchParams {
  const f = applicableFilters(filters);
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = f[key];
    if (value === undefined || value === false || value === '') continue;
    if (key === 'sort' && value === DEFAULT_FILTERS.sort) continue;
    if (key === 'page' && value === DEFAULT_FILTERS.page) continue;
    if (key === 'category') params.set(key, CATEGORY_ALIAS[value as FileCategoryId]);
    else if (key === 'excludeGenerated') params.set(key, '1');
    else params.set(key, String(value));
  }
  return params;
}

/** The filters a user set ("Resetează filtrele" and the applied count); sort and page are not filters. */
export function activeFilterCount(f: FileFilters): number {
  return KEYS.filter((k) => k !== 'sort' && k !== 'page' && f[k] !== undefined && f[k] !== false).length;
}

/**
 * `storage` and `uploader` are not filters of the real `GET /files` yet (backend ask, docs/api.md "Files"): the
 * list narrows them in the browser (queries.ts) and never sends them.
 */
export function hasLocalOnlyFilter(f: FileFilters): boolean {
  return f.storage !== undefined || f.uploader !== undefined;
}

/** "+02:00" or "+03:00": Bucharest's UTC offset on that day (noon avoids the DST switch hour). */
function bucharestOffset(day: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Bucharest', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = name?.replace('GMT', '');
  return offset ? offset : '+00:00';
}

/** The query of the real `GET /files` (docs/api.md "Files"): ISO times with an offset, string values. */
export function toApiQuery(f: FileFilters, paging: { page: number; pageSize: number }): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.category) q.category = f.category;
  if (f.q) q.q = f.q;
  if (f.zone) q.zone = f.zone;
  if (f.from) q.from = `${f.from}T00:00:00${bucharestOffset(f.from)}`;
  if (f.to) q.to = `${f.to}T23:59:59.999${bucharestOffset(f.to)}`;
  if (f.integrity) q.integrity = f.integrity;
  if (f.origin) q.origin = f.origin;
  if (f.excludeGenerated) q.excludeGenerated = 'true';
  q.sort = f.sort;
  q.page = String(paging.page);
  q.pageSize = String(paging.pageSize);
  return q;
}

/** A meter id as the ingest accepts it (backend meters.schemas.ts); no other id can match a reading. */
const METER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The query of the real `GET /meter-readings` (docs/api.md "Meter readings"): the search is the exact meter id.
 * Null when the search cannot be a meter id: nothing can match, so nothing is asked (the backend would refuse an
 * id over 64 characters with a 422).
 */
export function toMeterApiQuery(f: FileFilters, paging: { page: number; pageSize: number }): Record<string, string> | null {
  if (f.q !== undefined && !METER_ID.test(f.q)) return null;
  const q: Record<string, string> = {};
  if (f.q) q.meterId = f.q;
  if (f.zone) q.zone = f.zone;
  if (f.origin) q.origin = f.origin;
  q.page = String(paging.page);
  q.pageSize = String(paging.pageSize);
  return q;
}
