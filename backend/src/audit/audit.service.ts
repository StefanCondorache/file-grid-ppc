import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Category, Role } from '../common/domain';
import type { Database } from '../database/schema';
import { currentTraceId } from '../observability/trace-context';

/** Audit actions; the names match the frontend's AuditAction enum (plus storage_stop/start). */
export const AUDIT_ACTIONS = [
  'login',
  'logout',
  'role_switch',
  'upload',
  'download',
  'verify',
  'reveal_pii',
  'policy_update',
  'storm_start',
  'storm_stop',
  'file_corrupted',
  'storage_stop',
  'storage_start',
  'simulator_rate',
  'alert_ack',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  readonly actor: string;
  readonly action: AuditAction;
  readonly outcome: 'success' | 'failure' | 'denied';
  readonly actingAs?: Role | null;
  readonly demo?: boolean;
  readonly category?: Category | null;
  readonly fileId?: string | null;
  readonly reason?: string | null;
  /** Short, non-personal summary ("chunkSize 5 MiB -> 16 MiB"). Never a request body. */
  readonly details?: string | null;
}

const ACTOR_MAX = 64;
const DETAILS_MAX = 1000;

/** Who did what, to which file, with which outcome. Pass a transaction to commit atomically. */
@Injectable()
export class AuditService {
  async record(executor: Kysely<Database>, entry: AuditEntry): Promise<void> {
    await executor
      .insertInto('audit_log')
      .values({
        actor: entry.actor.slice(0, ACTOR_MAX),
        acting_as: entry.actingAs ?? null,
        demo: entry.demo ?? false,
        action: entry.action,
        outcome: entry.outcome,
        category: entry.category ?? null,
        file_id: entry.fileId ?? null,
        reason: entry.reason ?? null,
        details: entry.details?.slice(0, DETAILS_MAX) ?? null,
        trace_id: currentTraceId() ?? null,
      })
      .execute();
  }
}
