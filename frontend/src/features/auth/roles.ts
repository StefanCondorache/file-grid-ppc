import type { Role } from '@/lib/api/types';
import { ro } from '@/lib/i18n/ro';

/** Login and header dropdown order (ADR-0022). */
export const ROLE_ORDER: Role[] = ['teren', 'dispecerat', 'racordari', 'auditor', 'admin'];

export const ROLE_OPTIONS = ROLE_ORDER.map((role) => ({ role, ...ro.auth.roles[role] }));

export function roleLabel(role: Role): string {
  return ro.auth.roles[role].label;
}
