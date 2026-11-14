import { fromOpenApi } from '@mswjs/source/open-api';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { API_BASE } from '@/lib/api/base';
import { GROUPS, pathGroup, type Group } from '../groups';
import spec from '../openapi.json';
import { actingRoleHandlers, authHandlers } from './auth';
import { createStreamHandlers } from './stream';
import { uploadHandlers } from './uploads';
import { monitoringHandlers } from './monitoring';

/** Hand-written handlers per group; each slice appends its import here (append-only). */
export const groupHandlers: Record<Group, RequestHandler[]> = {
  auth: [...authHandlers],
  policies: [],
  uploads: [...uploadHandlers],
  files: [],
  audit: [],
  meters: [],
  monitoring: [...monitoringHandlers],
  statistics: [],
  demo: [...actingRoleHandlers],
  stream: createStreamHandlers(),
};

function relativePath(handler: RequestHandler): string | null {
  const raw = (handler.info as { path?: unknown }).path;
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf(API_BASE);
  return at >= 0 ? raw.slice(at + API_BASE.length) : raw;
}

/**
 * Hand-written handlers first, then the OpenAPI baseline only for groups without hand-written handlers,
 * then 501 NOT_MOCKED for anything else in an enabled group. Requests of disabled groups pass through.
 */
export async function buildHandlers(
  groups: readonly Group[] | 'all',
  overrides: Partial<Record<Group, RequestHandler[]>> = {},
): Promise<RequestHandler[]> {
  const enabled: readonly Group[] = groups === 'all' ? GROUPS : groups;
  const written = (g: Group) => [...(overrides[g] ?? []), ...groupHandlers[g]];
  const handwritten = new Set(enabled.filter((g) => written(g).length > 0));

  let baseline: RequestHandler[] = [];
  try {
    baseline = (await fromOpenApi(spec as never)).filter((h) => {
      const path = relativePath(h);
      const g = path ? pathGroup(path) : null;
      return g !== null && enabled.includes(g) && !handwritten.has(g);
    });
  } catch (error) {
    console.warn('[mocks] OpenAPI baseline unavailable, hand-written handlers only', error);
  }

  const notMocked = http.all(`${API_BASE}/*`, ({ request }) => {
    const g = pathGroup(new URL(request.url).pathname.slice(API_BASE.length));
    if (!g || !enabled.includes(g)) return undefined; // disabled group: pass through to the real API
    return HttpResponse.json({ code: 'NOT_MOCKED', message: 'Endpoint-ul nu are încă date simulate.', traceId: 'mock' }, { status: 501 });
  });

  return [...enabled.flatMap(written), ...baseline, notMocked];
}
