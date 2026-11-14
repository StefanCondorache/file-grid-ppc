import type { Capability, Role, UserRef } from '@/lib/api/types';

/** Mock-only password for all five demo accounts (never a real secret). */
export const SEED_PASSWORD = 'demo-2026';

export const SEED_USERS: UserRef[] = [
  { id: 'u-teren', username: 'teren', displayName: 'Ion Pop', role: 'teren' },
  { id: 'u-dispecerat', username: 'dispecerat', displayName: 'Elena Marin', role: 'dispecerat' },
  { id: 'u-racordari', username: 'racordari', displayName: 'Andrei Stan', role: 'racordari' },
  { id: 'u-auditor', username: 'auditor', displayName: 'Maria Ionescu', role: 'auditor' },
  { id: 'u-admin', username: 'admin', displayName: 'Administrator', role: 'admin' },
];

/** FE-01 role × capability matrix (backend-enforced in the real API). Admin cannot reveal PII. */
export const CAPABILITIES: Record<Role, Capability[]> = {
  teren: ['upload_drone', 'upload_fault', 'view_drone', 'view_fault'],
  dispecerat: ['upload_fault', 'view_drone', 'view_fault', 'view_meters'],
  racordari: ['upload_connection', 'view_connection'],
  auditor: ['view_drone', 'view_fault', 'view_connection', 'reveal_pii', 'view_meters', 'view_observability', 'view_statistics', 'view_audit'],
  admin: ['upload_drone', 'upload_fault', 'upload_connection', 'view_drone', 'view_fault', 'view_connection', 'view_meters', 'view_observability', 'view_statistics', 'view_audit', 'edit_policies', 'demo_controls'],
};
