import { AUDIT_ACTIONS, type AuditActionName, type AuditFilters } from './types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ORDER = ['action', 'actor', 'fileId', 'from', 'to', 'page'] as const;

/** Reads the audit filters from the URL; unknown or malformed values are dropped. */
export function filtersFromParams(params: URLSearchParams): AuditFilters {
  const f: AuditFilters = {};
  const action = params.get('action');
  if (action && (AUDIT_ACTIONS as readonly string[]).includes(action)) f.action = action as AuditActionName;
  const actor = params.get('actor')?.trim();
  if (actor) f.actor = actor.slice(0, 64);
  const fileId = params.get('fileId')?.trim();
  if (fileId) f.fileId = fileId.slice(0, 128);
  for (const key of ['from', 'to'] as const) {
    const v = params.get(key);
    if (v && DATE.test(v)) f[key] = v;
  }
  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page > 1) f.page = page;
  return f;
}

export function filtersToParams(f: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ORDER) {
    const v = f[key];
    if (v !== undefined && v !== '' && !(key === 'page' && v === 1)) params.set(key, String(v));
  }
  return params;
}

/** API query: local day bounds become ISO datetimes with offset (the backend's z.iso.datetime). */
export function filtersToQuery(f: AuditFilters, pageSize: number) {
  return {
    action: f.action,
    actor: f.actor,
    fileId: f.fileId,
    from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
    to: f.to ? new Date(`${f.to}T23:59:59.999`).toISOString() : undefined,
    page: f.page ?? 1,
    pageSize,
  };
}
