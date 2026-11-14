import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditOutcome, Category } from '../common/domain';
import type { Database } from '../database/schema';
import { currentTraceId } from '../observability/trace-context';

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly category?: Category;
  readonly fileId?: string;
  readonly details?: Record<string, unknown>;
}

const ACTOR_MAX = 64;

/** Who did what, to which file, with which outcome. Pass a transaction to commit atomically. */
@Injectable()
export class AuditService {
  async record(executor: Kysely<Database>, entry: AuditEntry): Promise<void> {
    await executor
      .insertInto('audit_log')
      .values({
        actor: entry.actor.slice(0, ACTOR_MAX),
        action: entry.action,
        outcome: entry.outcome,
        category: entry.category ?? null,
        file_id: entry.fileId ?? null,
        trace_id: currentTraceId() ?? null,
        details: JSON.stringify(entry.details ?? {}),
      })
      .execute();
  }
}
