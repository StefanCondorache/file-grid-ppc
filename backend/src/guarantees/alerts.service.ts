import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { DB, type Db } from '../database/database';
import type { AlertsTable } from '../database/schema';
import { EventBus } from '../events/event-bus.service';
import type { GuaranteeStatus } from './guarantees.service';

type AlertRow = Selectable<AlertsTable> & {
  acknowledged_display_name?: string | null;
  acknowledged_role?: string | null;
};

export interface AlertQuery {
  readonly state: 'active' | 'resolved' | 'all';
  readonly page: number;
  readonly pageSize: number;
}

export function alertView(row: AlertRow) {
  return {
    id: row.id,
    category: row.category,
    state: row.state,
    raisedAt: row.raised_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    causeCode: row.cause_code,
    causeFacts: row.cause_facts,
    traceId: row.trace_id,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    acknowledgedBy: row.acknowledged_by
      ? {
          id: row.acknowledged_by,
          username: row.acknowledged_by,
          displayName: row.acknowledged_display_name ?? row.acknowledged_by,
          role: row.acknowledged_role ?? null,
        }
      : null,
  };
}

const alertNotFound = (): AppError => new AppError(404, 'NOT_FOUND', 'Alerta nu există.');

/**
 * Guarantee alerts: one row per incident and category. A guarantee that leaves `ok` raises one
 * (alert.raised); a change between at_risk and violated, or of the cause, updates it; back to `ok`
 * resolves it (alert.updated). Only transitions write, so evaluating often is cheap.
 */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async record(statuses: readonly GuaranteeStatus[]): Promise<void> {
    for (const status of statuses) await this.transition(status);
  }

  private async transition(status: GuaranteeStatus): Promise<void> {
    const open = await this.db
      .selectFrom('alerts')
      .selectAll()
      .where('category', '=', status.category)
      .where('state', '<>', 'resolved')
      .executeTakeFirst();
    if (status.state === 'ok') {
      if (!open) return;
      const resolved = await this.db
        .updateTable('alerts')
        .set({ state: 'resolved', resolved_at: new Date(), updated_at: new Date() })
        .where('id', '=', open.id)
        .where('state', '<>', 'resolved')
        .returningAll()
        .executeTakeFirst();
      if (resolved) this.events.publish('alert.updated', alertView(resolved));
      return;
    }
    const causeCode = status.causeCode ?? 'GUARANTEE_AT_RISK';
    if (!open) {
      const raised = await this.db
        .insertInto('alerts')
        .values({
          category: status.category,
          state: status.state,
          cause_code: causeCode,
          cause_facts: JSON.stringify(status.causeFacts),
        })
        // Another replica raised it first: the partial unique index keeps one open alert.
        .onConflict((conflict) =>
          conflict.column('category').where('state', '<>', 'resolved').doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (raised) this.events.publish('alert.raised', alertView(raised));
      return;
    }
    if (open.state === status.state && open.cause_code === causeCode) return;
    const updated = await this.db
      .updateTable('alerts')
      .set({
        state: status.state,
        cause_code: causeCode,
        cause_facts: JSON.stringify(status.causeFacts),
        updated_at: new Date(),
      })
      .where('id', '=', open.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    this.events.publish('alert.updated', alertView(updated));
  }

  async list(query: AlertQuery) {
    let base = this.db
      .selectFrom('alerts')
      .leftJoin('users', 'users.username', 'alerts.acknowledged_by');
    if (query.state === 'active') base = base.where('alerts.state', '<>', 'resolved');
    if (query.state === 'resolved') base = base.where('alerts.state', '=', 'resolved');
    const [rows, count] = await Promise.all([
      base
        .selectAll('alerts')
        .select([
          'users.display_name as acknowledged_display_name',
          'users.role as acknowledged_role',
        ])
        .orderBy('alerts.raised_at', 'desc')
        .orderBy('alerts.id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    const total = Number(count.total);
    return {
      data: rows.map(alertView),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    };
  }

  /** Who saw it, and when; a second acknowledgement changes nothing (idempotent). */
  async acknowledge(alertId: string, principal: Principal) {
    if (!/^[0-9a-f-]{36}$/.test(alertId)) throw alertNotFound();
    const acknowledged = await this.db
      .updateTable('alerts')
      .set({ acknowledged_at: new Date(), acknowledged_by: principal.username })
      .where('id', '=', alertId)
      .where('acknowledged_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (acknowledged) {
      await this.audit.record(this.db, {
        actor: principal.username,
        actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
        action: 'alert_ack',
        outcome: 'success',
        category: acknowledged.category,
        details: `${acknowledged.cause_code} (${acknowledged.state})`,
      });
    }
    const row = await this.db
      .selectFrom('alerts')
      .leftJoin('users', 'users.username', 'alerts.acknowledged_by')
      .selectAll('alerts')
      .select([
        'users.display_name as acknowledged_display_name',
        'users.role as acknowledged_role',
      ])
      .where('alerts.id', '=', alertId)
      .executeTakeFirst();
    if (!row) throw alertNotFound();
    const view = alertView(row);
    if (acknowledged) this.events.publish('alert.updated', view);
    return view;
  }
}
