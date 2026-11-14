import type { AuditEvent, Category } from '@/lib/api/types';

export type AuditOutcome = 'success' | 'failure' | 'denied';

/**
 * docs/api.md wins over schema.d.ts here: the backend also sends `outcome`, `category` and `clientIp`,
 * and accepts the actions below (storage_stop / storage_start are not in the schema enum yet).
 * Backend ask: regenerate openapi.json with these fields and the `actor` query param.
 */
export type AuditRow = Omit<AuditEvent, 'action'> & {
  action: AuditActionName;
  outcome?: AuditOutcome;
  category?: Category | null;
  clientIp?: string | null;
};

export const AUDIT_ACTIONS = [
  'login', 'logout', 'role_switch', 'upload', 'download', 'verify', 'reveal_pii', 'policy_update',
  'storm_start', 'storm_stop', 'file_corrupted', 'storage_stop', 'storage_start', 'simulator_rate', 'alert_ack',
] as const;
export type AuditActionName = (typeof AUDIT_ACTIONS)[number];

/** Filters as they live in the URL (dates are YYYY-MM-DD, local day). */
export type AuditFilters = {
  action?: AuditActionName;
  actor?: string;
  fileId?: string;
  from?: string;
  to?: string;
  page?: number;
};
