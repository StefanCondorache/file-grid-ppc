import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated } from '../auth/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../database/database';
import { AUDIT_ACTIONS } from './audit.service';

export const auditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actor: z.string().trim().min(1).max(64).optional(),
  /** The proposal's name for `actor`: audit rows identify people by username. */
  userId: z.string().trim().min(1).max(64).optional(),
  fileId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** GET /audit-events: the audit trail for the auditor and the admin, newest first (BA-22). */
@Controller('audit-events')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Authenticated('view_audit')
  async list(@Query(new ZodPipe(auditQuerySchema)) query: AuditQuery) {
    const actor = query.actor ?? query.userId;
    let base = this.db
      .selectFrom('audit_log')
      .leftJoin('users', 'users.username', 'audit_log.actor')
      .leftJoin('files', 'files.id', 'audit_log.file_id');
    if (query.action) base = base.where('audit_log.action', '=', query.action);
    if (actor) base = base.where('audit_log.actor', '=', actor);
    if (query.fileId) base = base.where('audit_log.file_id', '=', query.fileId);
    if (query.from) base = base.where('audit_log.at', '>=', new Date(query.from));
    if (query.to) base = base.where('audit_log.at', '<=', new Date(query.to));
    const [rows, count] = await Promise.all([
      base
        .select([
          'audit_log.id',
          'audit_log.at',
          'audit_log.actor',
          'audit_log.acting_as',
          'audit_log.demo',
          'audit_log.action',
          'audit_log.outcome',
          'audit_log.category',
          'audit_log.file_id',
          'audit_log.reason',
          'audit_log.details',
          'audit_log.trace_id',
          'audit_log.client_ip',
          'users.id as user_id',
          'users.display_name',
          'users.role',
          'files.display_name as file_display_name',
        ])
        .orderBy('audit_log.at', 'desc')
        .orderBy('audit_log.id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    const total = Number(count.total);
    return {
      data: rows.map((row) => ({
        id: String(row.id),
        at: row.at.toISOString(),
        actor: {
          id: row.user_id ?? row.actor,
          username: row.actor,
          displayName: row.display_name ?? row.actor,
          role: row.role ?? null,
        },
        actingAs: row.acting_as,
        demo: row.demo,
        action: row.action,
        outcome: row.outcome,
        category: row.category,
        fileId: row.file_id,
        fileDisplayName: row.file_display_name ?? null,
        reason: row.reason,
        details: row.details,
        traceId: row.trace_id,
        clientIp: row.client_ip,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    };
  }
}
