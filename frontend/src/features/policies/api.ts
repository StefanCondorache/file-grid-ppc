import { apiUrl } from '@/lib/api/base';
import { csrfHeaders } from '@/lib/api/csrf';
import { ApiError, networkError, toApiError } from '@/lib/api/errors';
import { toPolicy, type PolicyCategory, type PolicyDoc, type PolicyUpdate, type PolicyVersionEntry } from './types';

/**
 * Policy calls (docs/api.md "Policies"). Not through openapi-fetch: schema.d.ts still types the proposal's ids,
 * while the backend answers with `fault_records`/`s3`. The whole error body is kept as `details` (currentPolicy).
 */
async function call(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'http://localhost';
  const headers: Record<string, string> = { Accept: 'application/json', ...csrfHeaders(method) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(new URL(apiUrl(path), origin).href, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (cause) {
    throw networkError(cause);
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = toApiError(res, json);
    throw new ApiError(e.status, e.code, e.message, e.traceId, e.fieldErrors, e.retryAfterMs, json);
  }
  return json;
}

const list = (raw: unknown): unknown[] => (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : []);

export const policyApi = {
  async list(): Promise<PolicyDoc[]> {
    return list(await call('GET', '/policies')).map(toPolicy);
  },
  async get(category: PolicyCategory): Promise<PolicyDoc> {
    return toPolicy(await call('GET', `/policies/${category}`));
  },
  async versions(category: PolicyCategory): Promise<PolicyVersionEntry[]> {
    return list(await call('GET', `/policies/${category}/versions`)) as PolicyVersionEntry[];
  },
  async save(category: PolicyCategory, update: PolicyUpdate): Promise<PolicyDoc> {
    return toPolicy(await call('PUT', `/policies/${category}`, update));
  },
};

/** The server's policy carried by a 409 POLICY_VERSION_CONFLICT, or null. */
export function conflictPolicy(error: unknown): PolicyDoc | null {
  if (!(error instanceof ApiError) || error.code !== 'POLICY_VERSION_CONFLICT') return null;
  const current = (error.details as { currentPolicy?: unknown } | null)?.currentPolicy;
  try {
    return current ? toPolicy(current) : null;
  } catch {
    return null;
  }
}
