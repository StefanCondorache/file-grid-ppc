import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import type { Role } from '@/lib/api/types';
import { db } from '../db';
import { SEED_PASSWORD, SEED_USERS } from '../seed/auth';
import { currentSession, endSession, mockSettings, startSession, toMe, touchSession, userById } from '../session';

const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const fail = (status: number, code: string, message: string) => HttpResponse.json({ code, message, traceId: trace() }, { status });
const unauthenticated = () => fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
const ACTING_ROLES: Role[] = ['teren', 'dispecerat', 'racordari', 'auditor'];

export const authHandlers = [
  http.post(apiUrl('/auth/login'), async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    const user = SEED_USERS.find((u) => u.username === body.username);
    if (!user || body.password !== SEED_PASSWORD) return fail(401, 'INVALID_CREDENTIALS', 'Rol sau parolă greșită.');
    const s = startSession(user);
    db.audit.append({ actor: user, actingAs: null, demo: false, action: 'login', traceId: trace() });
    return HttpResponse.json(toMe(s));
  }),
  http.get(apiUrl('/auth/me'), () => {
    const s = touchSession();
    return s ? HttpResponse.json(toMe(s)) : unauthenticated();
  }),
  http.post(apiUrl('/auth/refresh'), () => {
    const s = touchSession();
    return s ? HttpResponse.json(toMe(s)) : unauthenticated();
  }),
  http.post(apiUrl('/auth/logout'), () => {
    const s = currentSession();
    if (s) db.audit.append({ actor: userById(s.realUserId), actingAs: null, demo: false, action: 'logout', traceId: trace() });
    endSession();
    return new HttpResponse(null, { status: 204 });
  }),
];

/** Registered under the `demo` group (pathGroup('/demo/acting-role') === 'demo'). */
export const actingRoleHandlers = [
  http.post(apiUrl('/demo/acting-role'), async ({ request }) => {
    const s = currentSession();
    if (!s) return unauthenticated();
    const real = userById(s.realUserId)!;
    if (!(mockSettings().demoMode ?? true)) return fail(404, 'NOT_FOUND', 'Mod demo oprit.');
    if (real.role !== 'admin') return fail(403, 'FORBIDDEN', 'Doar administratorul poate schimba rolul.');
    const { role } = (await request.json()) as { role: Role };
    if (!ACTING_ROLES.includes(role)) return fail(422, 'VALIDATION_ERROR', 'Rol necunoscut.');
    const next = touchSession({ activeRole: role })!;
    db.audit.append({ actor: real, actingAs: role, demo: true, action: 'role_switch', details: `${s.activeRole} → ${role}`, traceId: trace() });
    return HttpResponse.json(toMe(next));
  }),
  http.delete(apiUrl('/demo/acting-role'), () => {
    const s = currentSession();
    if (!s) return unauthenticated();
    const real = userById(s.realUserId)!;
    const next = touchSession({ activeRole: real.role })!;
    db.audit.append({ actor: real, actingAs: null, demo: true, action: 'role_switch', details: `${s.activeRole} → ${real.role}`, traceId: trace() });
    return HttpResponse.json(toMe(next));
  }),
];
