import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Principal, UserRef } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import {
  CATEGORIES,
  type Category,
  MAX_CHUNK_SIZE,
  MAX_PARALLEL,
  MIN_CHUNK_SIZE,
  STORAGES,
} from '../common/domain';
import { DB, type Db } from '../database/database';
import { EventBus } from '../events/event-bus.service';
import type { PoliciesTable, PolicyChangeRow } from '../database/schema';
import type { Policy, PolicyView } from './policy.types';
import { z } from 'zod';

const SYSTEM_USER: UserRef = {
  id: 'system',
  username: 'system',
  displayName: 'Sistem',
  role: 'admin',
};
const MiB = 1024 * 1024;

export const policyUpdateSchema = z
  .object({
    baseVersion: z.number().int().min(1),
    primaryStorage: z.enum(STORAGES),
    fallbackStorage: z.enum(STORAGES).nullable().default(null),
    encryptionAtRest: z.boolean(),
    chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
    maxParallel: z.number().int().min(1).max(MAX_PARALLEL),
    maxConcurrency: z.number().int().min(1).max(256).optional(),
    maxFileSize: z.number().int().min(1),
    allowedTypes: z.array(z.string().trim().min(1).max(127)).max(50),
    retentionDays: z.number().int().min(1).max(36_500),
  })
  .refine((body) => body.fallbackStorage !== body.primaryStorage, {
    path: ['fallbackStorage'],
    message: 'Storage-ul de rezervă trebuie să fie diferit de cel principal.',
  });
export type PolicyUpdate = z.infer<typeof policyUpdateSchema>;

type PolicyRow = Selectable<PoliciesTable>;

function toPolicy(row: PolicyRow): Policy {
  return {
    category: row.category,
    version: row.version,
    primaryStorage: row.primary_storage,
    fallbackStorage: row.fallback_storage,
    encrypted: row.encrypted,
    chunkSize: row.chunk_size_bytes,
    maxParallel: row.max_parallel,
    maxConcurrency: row.max_concurrency,
    maxFileSize: Number(row.max_file_size_bytes),
    allowedTypes: row.allowed_types,
    retentionDays: row.retention_days,
  };
}

function bytes(value: number): string {
  return value % MiB === 0 ? `${value / MiB} MiB` : `${value} B`;
}

/** Field-by-field differences, worded for the audit trail and the policy history. */
function diff(before: Policy, after: Policy): PolicyChangeRow[] {
  const fields: [string, (p: Policy) => string | null][] = [
    ['primaryStorage', (p) => p.primaryStorage],
    ['fallbackStorage', (p) => p.fallbackStorage],
    ['encryptionAtRest', (p) => String(p.encrypted)],
    ['chunkSize', (p) => bytes(p.chunkSize)],
    ['maxParallel', (p) => String(p.maxParallel)],
    ['maxConcurrency', (p) => String(p.maxConcurrency)],
    ['maxFileSize', (p) => bytes(p.maxFileSize)],
    ['allowedTypes', (p) => p.allowedTypes.join(', ')],
    ['retentionDays', (p) => String(p.retentionDays)],
  ];
  return fields
    .map(([field, read]) => ({ field, from: read(before), to: read(after) }))
    .filter((change) => change.from !== change.to);
}

/**
 * The policy engine: one row per category in the database decides where files go (primary and
 * fallback storage), whether they are encrypted, the upload part size and the concurrency limits.
 * Every operation reads it live, so a PUT changes behaviour immediately on every replica.
 */
@Injectable()
export class PoliciesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async get(category: Category): Promise<Policy> {
    const row = await this.db
      .selectFrom('policies')
      .selectAll()
      .where('category', '=', category)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Categoria nu există.');
    return toPolicy(row);
  }

  async list(): Promise<PolicyView[]> {
    const rows = await this.db.selectFrom('policies').selectAll().execute();
    const order = (category: Category) => CATEGORIES.indexOf(category);
    const sorted = [...rows].sort((a, b) => order(a.category) - order(b.category));
    return Promise.all(sorted.map((row) => this.view(row)));
  }

  async getView(category: Category): Promise<PolicyView> {
    const row = await this.db
      .selectFrom('policies')
      .selectAll()
      .where('category', '=', category)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Categoria nu există.');
    return this.view(row);
  }

  async update(category: Category, body: PolicyUpdate, principal: Principal): Promise<PolicyView> {
    if (category === 'connection_documents' && !body.encryptionAtRest) {
      throw new AppError(422, 'ENCRYPTION_LOCKED', 'Documentele de racordare se criptează mereu.', {
        fieldErrors: [
          { field: 'encryptionAtRest', code: 'locked', message: 'Criptarea nu poate fi oprită.' },
        ],
      });
    }
    const saved = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('policies')
        .selectAll()
        .where('category', '=', category)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Categoria nu există.');
      if (current.version !== body.baseVersion) {
        throw new AppError(
          409,
          'POLICY_VERSION_CONFLICT',
          'Politica a fost modificată între timp. Reîncărcați versiunea curentă.',
          { currentPolicy: await this.view(current) },
        );
      }
      const before = toPolicy(current);
      const updated = await trx
        .updateTable('policies')
        .set({
          version: current.version + 1,
          primary_storage: body.primaryStorage,
          fallback_storage: body.fallbackStorage,
          encrypted: body.encryptionAtRest,
          chunk_size_bytes: body.chunkSize,
          max_parallel: body.maxParallel,
          max_concurrency: body.maxConcurrency ?? current.max_concurrency,
          max_file_size_bytes: body.maxFileSize,
          allowed_types: JSON.stringify(body.allowedTypes),
          retention_days: body.retentionDays,
          updated_at: new Date(),
          updated_by: principal.username,
        })
        .where('category', '=', category)
        .returningAll()
        .executeTakeFirstOrThrow();
      const changes = diff(before, toPolicy(updated));
      await trx
        .insertInto('policy_versions')
        .values({
          category,
          version: updated.version,
          snapshot: JSON.stringify(toPolicy(updated)),
          changes: JSON.stringify(changes),
          changed_by: principal.username,
        })
        .execute();
      await this.audit.record(trx, {
        actor: principal.username,
        actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
        action: 'policy_update',
        outcome: 'success',
        category,
        details: changes.map((c) => `${c.field} ${c.from ?? '-'} → ${c.to ?? '-'}`).join('; '),
      });
      return updated;
    });
    this.events.publish('policy.updated', { category, version: saved.version });
    return this.view(saved);
  }

  async versions(category: Category) {
    await this.get(category);
    const rows = await this.db
      .selectFrom('policy_versions')
      .selectAll()
      .where('category', '=', category)
      .orderBy('version', 'desc')
      .limit(100)
      .execute();
    const users = await this.users(rows.map((row) => row.changed_by));
    return rows.map((row) => ({
      version: row.version,
      policy: row.snapshot,
      changedAt: row.changed_at.toISOString(),
      changedBy: users.get(row.changed_by) ?? SYSTEM_USER,
      changes: row.changes,
    }));
  }

  private async view(row: PolicyRow): Promise<PolicyView> {
    const users = await this.users([row.updated_by]);
    const policy = toPolicy(row);
    return {
      category: policy.category,
      version: policy.version,
      primaryStorage: policy.primaryStorage,
      fallbackStorage: policy.fallbackStorage,
      encryptionAtRest: policy.encrypted,
      encryptionLocked: policy.category === 'connection_documents',
      encryptionAlgorithm: policy.encrypted ? 'AES-256-GCM' : null,
      chunkSize: policy.chunkSize,
      maxParallel: policy.maxParallel,
      maxConcurrency: policy.maxConcurrency,
      maxFileSize: policy.maxFileSize,
      allowedTypes: policy.allowedTypes,
      retentionDays: policy.retentionDays,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: users.get(row.updated_by) ?? SYSTEM_USER,
    };
  }

  private async users(usernames: readonly string[]): Promise<Map<string, UserRef>> {
    const wanted = [...new Set(usernames)].filter((name) => name !== 'system');
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'role'])
      .where('username', 'in', wanted)
      .execute();
    return new Map(
      rows.map((row) => [
        row.username,
        { id: row.id, username: row.username, displayName: row.display_name, role: row.role },
      ]),
    );
  }
}
