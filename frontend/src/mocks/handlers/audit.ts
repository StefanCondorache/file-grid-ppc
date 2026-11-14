import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { CAPABILITIES } from '../seed/auth';
import { currentSession } from '../session';

type Row = { id: string; at: string; actor: { id: string }; action: string; fileId?: string | null; [k: string]: unknown };

const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const fail = (status: number, code: string, message: string) => HttpResponse.json({ code, message, traceId: trace() }, { status });

/** GET /audit-events: view_audit only, newest first, filters and paging like the real API (docs/api.md). */
export const auditHandlers = [
  http.get(apiUrl('/audit-events'), ({ request }) => {
    const s = currentSession();
    if (!s) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
    if (!CAPABILITIES[s.activeRole].includes('view_audit')) return fail(403, 'FORBIDDEN', 'Nu ai acces la jurnalul de audit.');
    const q = new URL(request.url).searchParams;
    const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.get('pageSize') ?? 50) || 50));
    const action = q.get('action');
    const actor = q.get('actor');
    const fileId = q.get('fileId');
    const from = q.get('from');
    const to = q.get('to');
    const rows = db.list<Row>('audit')
      .filter((r) => (!action || r.action === action) && (!fileId || r.fileId === fileId))
      .filter((r) => !actor || r.actor.id === actor || (r.actor as { username?: string }).username === actor)
      .filter((r) => (!from || r.at >= from) && (!to || r.at <= to))
      .map((r) => ({ outcome: 'success', category: null, fileId: null, fileDisplayName: null, reason: null, details: null, clientIp: null, actingAs: null, ...r }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const data = rows.slice((page - 1) * pageSize, page * pageSize);
    return HttpResponse.json({ data, meta: { page, pageSize, total: rows.length, totalIsEstimate: false, hasMore: page * pageSize < rows.length } }, { headers: { 'X-Trace-Id': trace() } });
  }),
];
