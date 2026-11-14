import type { UserRef } from '@/lib/api/types';
import { FALLBACK_MATRIX } from '@/lib/auth/capabilities';

/** Mock-only password for all five demo accounts (never a real secret). */
export const SEED_PASSWORD = 'demo-2026';

export const SEED_USERS: UserRef[] = [
  { id: 'u-teren', username: 'teren', displayName: 'Ion Pop', role: 'teren' },
  { id: 'u-dispecerat', username: 'dispecerat', displayName: 'Elena Marin', role: 'dispecerat' },
  { id: 'u-racordari', username: 'racordari', displayName: 'Andrei Stan', role: 'racordari' },
  { id: 'u-auditor', username: 'auditor', displayName: 'Maria Ionescu', role: 'auditor' },
  { id: 'u-admin', username: 'admin', displayName: 'Administrator', role: 'admin' },
];

/** The mock server enforces the same FE-01 matrix the UI falls back to. */
export const CAPABILITIES = FALLBACK_MATRIX;
