import { http, HttpResponse } from 'msw';
import type { AuditRow } from '@/features/audit/types';
import { apiUrl } from '@/lib/api/base';
import { db } from '../db';
import { AUDIT_SEED } from '../seed/audit';
import { CAPABILITIES } from '../seed/auth';
import { currentSession } from '../session';

const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const fail = (status: number, code: string, message: string) => HttpResponse.json({ code, message, traceId: trace() }, { status });

/** Rows written by other mock handlers (login, role switch, reveal…) lack some fields: fill them like the backend. */
function normalize(e: Partial<AuditRow>): AuditRow {
  return {
    actingAs: null, demo: false, outcome: 'success', category: null, fileId: null, fileDisplayName: null,
    reason: null, details: null, clientIp: null, ...e,
  } as AuditRow;
}

/** GET /audit-events (docs/api.md): view_audit only, newest first, filtered by action / actor / fileId / from / to. */
export const auditHandlers = [
  http.get(apiUrl('/audit-events'), ({ request }) => {
    const s = currentSession();
    if (!s) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
    if (!CAPABILITIES[s.activeRole].includes('view_audit')) return fail(403, 'FORBIDDEN', 'Rolul activ nu poate vedea jurnalul de audit.');

    const q = new URL(request.url).searchParams;
    const action = q.get('action');
    const actor = q.get('actor') ?? q.get('userId');
    const fileId = q.get('fileId');
    const from = q.get('from') ? Date.parse(q.get('from')!) : null;
    const to = q.get('to') ? Date.parse(q.get('to')!) : null;
    const page = Math.max(1, Number(q.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.get('pageSize')) || 20));

    const rows = [...db.list<Partial<AuditRow>>('audit').map(normalize), ...AUDIT_SEED]
      .filter((e) => (!action || e.action === action)
        && (!actor || e.actor.username === actor)
        && (!fileId || e.fileId === fileId)
        && (from === null || Date.parse(e.at) >= from)
        && (to === null || Date.parse(e.at) <= to))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const data = rows.slice((page - 1) * pageSize, page * pageSize);
    return HttpResponse.json({
      data,
      meta: { page, pageSize, total: rows.length, totalIsEstimate: false, hasMore: page * pageSize < rows.length },
    });
  }),
];
