import type { Capability, Me, Role } from '@/lib/api/types';

/**
 * FE-01 role × capability matrix. The backend's `me.capabilities` is the source of truth (FA-25);
 * this copy is only a marked fallback while the backend does not send them. UI hiding is convenience, never security.
 */
export const FALLBACK_MATRIX: Record<Role, Capability[]> = {
  teren: ['upload_drone', 'upload_fault', 'view_drone', 'view_fault'],
  dispecerat: ['upload_fault', 'view_drone', 'view_fault', 'view_meters'],
  racordari: ['upload_connection', 'view_connection'],
  auditor: ['view_drone', 'view_fault', 'view_connection', 'reveal_pii', 'view_meters', 'view_observability', 'view_statistics', 'view_audit'],
  admin: ['upload_drone', 'upload_fault', 'upload_connection', 'view_drone', 'view_fault', 'view_connection', 'view_meters', 'view_observability', 'view_statistics', 'view_audit', 'edit_policies', 'demo_controls'],
};

export function can(me: Me | undefined, cap: Capability): boolean {
  if (!me) return false;
  const list = me.capabilities?.length ? me.capabilities : FALLBACK_MATRIX[me.activeRole] ?? [];
  return list.includes(cap);
}
