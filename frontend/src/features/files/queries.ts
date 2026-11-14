'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import type { IntegrityState, Origin, Role } from '@/lib/api/types';
import type { Severity, Zone } from '@/lib/upload/contract';
import type { StorageId } from '@/lib/upload/types';
import { hasLocalOnlyFilter, toApiQuery, toMeterApiQuery, type FileCategoryId, type FileFilters } from './filters';

export const PAGE_SIZE = 25;
/** The largest page `GET /files` serves: the window the browser narrows `storage` and `uploader` over. */
export const LOCAL_WINDOW = 200;

/**
 * `FileSummary` as the real backend sends it (docs/api.md "Files"). Hand-written because the generated
 * schema.d.ts still follows the OpenAPI proposal's ids (`fault`, `S3`).
 */
export type FileItem = {
  id: string;
  /** Display-safe (personal data never in it), but still untrusted: render through SafeName. */
  displayName: string;
  category: FileCategoryId;
  size: number;
  mimeType: string;
  createdAt: string;
  /** The username in every field and no role (files.service.ts); null for meter batches and system actors. */
  uploadedBy: { id: string; username: string; displayName: string; role: Role | null } | null;
  zone: Zone | null;
  origin: Origin;
  storage: StorageId;
  usedFallback: boolean;
  integrity: IntegrityState;
  encryptedAtRest: boolean;
  policyVersion: number;
  /** Backend ask: the non-personal fault metadata in the list. Today only `GET /files/{id}` carries it. */
  metadata?: { severity?: Severity; substation?: string } | null;
};

export type FilesPage = {
  items: FileItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** A browser-side filter ran over the newest LOCAL_WINDOW matches only, and the server had more. */
  partial: boolean;
};

type Wire = { data: FileItem[]; meta: { page: number; pageSize: number; total: number; hasMore: boolean } };

async function getFiles(query: Record<string, string>): Promise<Wire> {
  // The query and body follow docs/api.md, not the proposal types openapi-fetch was generated from.
  const body = (await unwrap(api.GET('/files', { params: { query: query as never } }))) as unknown as Partial<Wire> | null;
  if (!body || !Array.isArray(body.data) || !body.meta || typeof body.meta.total !== 'number') {
    throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected files list from the server');
  }
  return body as Wire;
}

export async function fetchFilesPage(f: FileFilters): Promise<FilesPage> {
  if (!hasLocalOnlyFilter(f)) {
    const { data, meta } = await getFiles(toApiQuery(f, { page: f.page, pageSize: PAGE_SIZE }));
    return { items: data, page: meta.page, pageSize: meta.pageSize, total: meta.total, hasMore: meta.hasMore, partial: false };
  }
  // `storage` and `uploader` are not filters of GET /files yet (backend ask): narrow the newest matches here,
  // and page locally so the count and "Afișate x–y din n" stay true.
  const { data, meta } = await getFiles(toApiQuery(f, { page: 1, pageSize: LOCAL_WINDOW }));
  const matched = data.filter((r) => (!f.storage || r.storage === f.storage) && (!f.uploader || r.uploadedBy?.username === f.uploader));
  const start = (f.page - 1) * PAGE_SIZE;
  return {
    items: matched.slice(start, start + PAGE_SIZE),
    page: f.page,
    pageSize: PAGE_SIZE,
    total: matched.length,
    hasMore: start + PAGE_SIZE < matched.length,
    partial: meta.hasMore,
  };
}

/** One page of the files list; the live stream invalidates `qk.files.all`, so new rows arrive by refetch. */
export function useFiles(f: FileFilters) {
  return useQuery({ queryKey: qk.files.list(f), queryFn: () => fetchFilesPage(f), placeholderData: keepPreviousData });
}

// ─── meter readings (6c.4) ─────────────────────────────────────────────────────────────────────────────────

/**
 * One reading as the real `GET /meter-readings` sends it (docs/api.md "Meter readings"; backend meters.service.ts
 * `list`). `fileId` is the stored batch the reading arrived in: the normal file detail and download (FE-11).
 */
export type MeterReading = {
  fileId: string;
  meterId: string;
  zone: Zone;
  readingTime: string;
  kwh: number;
  sequence: number;
  receivedAt: string;
  storage: StorageId;
  origin: Origin;
};

export type MeterReadingsPage = {
  items: MeterReading[];
  page: number;
  pageSize: number;
  /** Null when the server only estimates it: a filtered list counts every reading (`meta.totalIsEstimate`). */
  total: number | null;
  hasMore: boolean;
};

type ReadingsWire = { data: MeterReading[]; meta: { page: number; pageSize: number; total: number; hasMore: boolean; totalIsEstimate?: boolean } };

export async function fetchMeterReadingsPage(f: FileFilters): Promise<MeterReadingsPage> {
  const query = toMeterApiQuery(f, { page: f.page, pageSize: PAGE_SIZE });
  // A search that cannot be a meter id matches nothing: say so without asking.
  if (!query) return { items: [], page: f.page, pageSize: PAGE_SIZE, total: 0, hasMore: false };
  // The query follows docs/api.md (`origin`), not the proposal types openapi-fetch was generated from.
  const body = (await unwrap(api.GET('/meter-readings', { params: { query: query as never } }))) as unknown as Partial<ReadingsWire> | null;
  if (!body || !Array.isArray(body.data) || !body.meta || typeof body.meta.hasMore !== 'boolean') {
    throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected meter readings from the server');
  }
  const { data, meta } = body as ReadingsWire;
  const total = meta.totalIsEstimate || typeof meta.total !== 'number' ? null : meta.total;
  return { items: data, page: meta.page, pageSize: meta.pageSize, total, hasMore: meta.hasMore };
}

/**
 * One page of readings for `/files?category=meter`. Not fed by the live stream: readings arrive every few seconds,
 * so a page that reshuffled itself could not be read (the live view is `/meters`, FE-11).
 */
export function useMeterReadings(f: FileFilters) {
  return useQuery({ queryKey: qk.meters.readings(f), queryFn: () => fetchMeterReadingsPage(f), placeholderData: keepPreviousData });
}
