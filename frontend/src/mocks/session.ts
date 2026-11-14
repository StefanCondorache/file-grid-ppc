import type { Me, Role, UserRef } from '@/lib/api/types';
import { db } from './db';
import { CAPABILITIES, SEED_USERS } from './seed/auth';

/** Rehearsal knobs in localStorage['fg.mock'] (mocks only). */
export function mockSettings(): { sessionTtlMs?: number; idleTtlMs?: number; demoMode?: boolean } {
  try {
    return JSON.parse(globalThis.localStorage?.getItem('fg.mock') ?? '{}') as ReturnType<typeof mockSettings>;
  } catch {
    return {};
  }
}

type Session = { id: 'current'; realUserId: string; activeRole: Role; createdAt: number; lastSeenAt: number };

const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const ttl = () => ({ absolute: mockSettings().sessionTtlMs ?? ABSOLUTE_MS, idle: mockSettings().idleTtlMs ?? IDLE_MS });

export function endSession(): void {
  db.remove('sessions', () => true);
}

/** The single browser session of the mock "server"; expired sessions are ended. */
export function currentSession(now = Date.now()): Session | null {
  const s = db.find<Session>('sessions', (x) => x.id === 'current');
  if (!s) return null;
  const { absolute, idle } = ttl();
  if (now - s.createdAt > absolute || now - s.lastSeenAt > idle) {
    endSession();
    return null;
  }
  return s;
}

export function startSession(user: UserRef): Session {
  endSession();
  const now = Date.now();
  return db.insert<Session>('sessions', { id: 'current', realUserId: user.id, activeRole: user.role, createdAt: now, lastSeenAt: now });
}

export function touchSession(patch: Partial<Pick<Session, 'activeRole'>> = {}): Session | null {
  if (!currentSession()) return null;
  return db.update<Session>('sessions', (x) => x.id === 'current', { lastSeenAt: Date.now(), ...patch }) ?? null;
}

export function userById(id: string): UserRef | undefined {
  return SEED_USERS.find((u) => u.id === id);
}

export function toMe(s: Session): Me {
  const realUser = userById(s.realUserId)!;
  const { absolute, idle } = ttl();
  return {
    user: { ...realUser, role: s.activeRole },
    realUser,
    activeRole: s.activeRole,
    roles: [realUser.role],
    capabilities: CAPABILITIES[s.activeRole],
    demoMode: mockSettings().demoMode ?? true,
    actingRoleExpiresAt: s.activeRole === realUser.role ? null : new Date(s.lastSeenAt + 15 * 60 * 1000).toISOString(),
    expiresAt: new Date(s.createdAt + absolute).toISOString(),
    idleExpiresAt: new Date(s.lastSeenAt + idle).toISOString(),
    serverTime: new Date().toISOString(),
  };
}
