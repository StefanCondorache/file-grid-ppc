import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { CATEGORIES, type Category, VIEW_CAPABILITY, can } from '../common/domain';
import type { Keyring } from '../crypto/keys';
import { DB, type Db } from '../database/database';
import type { FilesTable } from '../database/schema';
import {
  KEYRING,
  ObjectStoreService,
  type StoredObject,
} from '../object-store/object-store.service';
import { INTEGRITY_FAILURES } from '../observability/app-metrics';
import { OperationsService } from '../observability/operations.service';
import { currentTraceId, span } from '../observability/trace-context';
import { HashingStream, IntegrityError } from '../storage/base';
import type { FileQuery } from './file.schemas';
import { openPii } from './pii';

export type FileRow = Selectable<FilesTable>;

const SYSTEM_ACTORS = /^(meter|system|demo):/;

export function fileNotFound(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Fișierul nu există.');
}

export function visibleCategories(principal: Principal): Category[] {
  return CATEGORIES.filter((category) => can(principal.activeRole, VIEW_CAPABILITY[category]));
}

function uploader(row: FileRow) {
  if (!row.uploaded_by || SYSTEM_ACTORS.test(row.uploaded_by)) return null;
  return {
    id: row.uploaded_by,
    username: row.uploaded_by,
    displayName: row.uploaded_by,
    role: null,
  };
}

export function fileSummary(row: FileRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    category: row.category,
    size: Number(row.size_bytes),
    mimeType: row.mime_type,
    createdAt: row.created_at.toISOString(),
    uploadedBy: uploader(row),
    zone: row.zone,
    origin: row.origin,
    storage: row.storage,
    usedFallback: row.used_fallback,
    integrity: row.integrity,
    encryptedAtRest: row.encrypted,
    policyVersion: row.policy_version,
  };
}

export function fileDetail(row: FileRow) {
  return {
    ...fileSummary(row),
    clientSha256: row.client_sha256,
    serverSha256: row.sha256,
    policyName: `${row.category} v${row.policy_version}`,
    encryptionAlgorithm: row.encrypted ? 'AES-256-GCM' : null,
    availableAt: row.created_at.toISOString(),
    uploadTraceId: row.upload_trace_id,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    metadata: row.metadata,
  };
}

export function located(row: FileRow): StoredObject {
  return {
    storage: row.storage,
    key: row.storage_key,
    encrypted: row.encrypted,
    storedSha256: row.stored_sha256,
  };
}

/** Search, metadata, integrity checks, custody and the personal-data reveal. */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KEYRING) private readonly keyring: Keyring | null,
    private readonly store: ObjectStoreService,
    private readonly audit: AuditService,
    private readonly operations: OperationsService,
  ) {}

  async search(principal: Principal, query: FileQuery) {
    const allowed = visibleCategories(principal);
    const categories = query.category ? allowed.filter((c) => c === query.category) : allowed;
    const meta = { page: query.page, pageSize: query.pageSize };
    if (categories.length === 0) return { data: [], meta: { ...meta, total: 0, hasMore: false } };
    let base = this.db.selectFrom('files').where('category', 'in', categories);
    if (query.q)
      base = base.where('display_name', 'ilike', `%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
    if (query.from) base = base.where('created_at', '>=', new Date(query.from));
    if (query.to) base = base.where('created_at', '<=', new Date(query.to));
    if (query.zone) base = base.where('zone', '=', query.zone);
    if (query.origin) base = base.where('origin', '=', query.origin);
    if (query.integrity) base = base.where('integrity', '=', query.integrity);
    if (query.excludeGenerated) base = base.where('origin', '=', 'manual');
    const descending = query.sort.startsWith('-');
    const column = query.sort.replace('-', '') === 'size' ? 'size_bytes' : 'created_at';
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy(column, descending ? 'desc' : 'asc')
        .orderBy('id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    const total = Number(count.total);
    return {
      data: rows.map(fileSummary),
      meta: { ...meta, total, hasMore: query.page * query.pageSize < total },
    };
  }

  /** The file row, or 404 when it does not exist or the active role may not see its category. */
  async visible(principal: Principal, fileId: string): Promise<FileRow> {
    if (!/^[0-9a-f-]{36}$/.test(fileId)) throw fileNotFound();
    const row = await this.db
      .selectFrom('files')
      .selectAll()
      .where('id', '=', fileId)
      .executeTakeFirst();
    if (!row || !can(principal.activeRole, VIEW_CAPABILITY[row.category])) throw fileNotFound();
    return row;
  }

  /** Re-reads the stored bytes and recomputes both hashes: POST /files/{id}/verification. */
  async verify(principal: Principal, fileId: string) {
    const row = await this.visible(principal, fileId);
    const plain = new HashingStream(this.store.read(row.category, located(row)));
    let corrupt = false;
    try {
      await span('hash.verify', { storage: row.storage, category: row.category }, async () => {
        for await (const _chunk of plain) {
          // only hashing
        }
      });
      corrupt = plain.sha256 !== row.sha256;
    } catch (error) {
      if (
        !(error instanceof IntegrityError) &&
        !(error instanceof Error && error.name === 'DecryptionError')
      ) {
        throw error;
      }
      corrupt = true;
    }
    if (corrupt) await this.markCorrupt(row, principal.username);
    else {
      await this.db
        .updateTable('files')
        .set({
          integrity: row.integrity === 'verified' ? 'verified' : 'server_verified',
          last_verified_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
    }
    await this.audit.record(this.db, {
      actor: principal.username,
      action: 'verify',
      outcome: corrupt ? 'failure' : 'success',
      category: row.category,
      fileId: row.id,
    });
    await this.operations.record({
      operation: 'file.verify',
      category: row.category,
      storage: row.storage,
      fileId: row.id,
      status: corrupt ? 'error' : 'ok',
    });
    return {
      fileId: row.id,
      state: corrupt ? 'corrupt' : 'server_verified',
      expectedSha256: row.sha256,
      actualSha256: plain.sha256,
      storage: row.storage,
      verifiedAt: new Date().toISOString(),
      traceId: currentTraceId() ?? '',
    };
  }

  async markCorrupt(row: FileRow, actor: string): Promise<void> {
    INTEGRITY_FAILURES.labels(row.category, row.storage).inc();
    await this.db
      .updateTable('files')
      .set({ integrity: 'corrupt', corrupted_at: new Date(), last_verified_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await this.audit.record(this.db, {
      actor,
      action: 'file_corrupted',
      outcome: 'failure',
      category: row.category,
      fileId: row.id,
      details: `stored hash mismatch on ${row.storage}`,
    });
  }

  async custody(principal: Principal, fileId: string) {
    const row = await this.visible(principal, fileId);
    const events = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('file_id', '=', row.id)
      .orderBy('at')
      .limit(200)
      .execute();
    const typeOf: Record<string, string> = {
      upload: 'upload_completed',
      download: 'downloaded',
      verify: 'verified',
      reveal_pii: 'pii_revealed',
      file_corrupted: 'corruption_detected',
    };
    const created = {
      id: `stored-${row.id}`,
      type: 'stored',
      at: row.created_at.toISOString(),
      actor: uploader(row),
      actingAs: null,
      demo: false,
      storage: row.storage,
      policyVersion: row.policy_version,
      reason: null,
      traceId: row.upload_trace_id,
    };
    return {
      data: [
        created,
        ...events.map((event) => ({
          id: event.id,
          type: event.details?.startsWith('demo')
            ? 'demo_corrupted'
            : (typeOf[event.action] ?? event.action),
          at: event.at.toISOString(),
          actor: { id: event.actor, username: event.actor, displayName: event.actor, role: null },
          actingAs: event.acting_as,
          demo: event.demo,
          storage: row.storage,
          policyVersion: row.policy_version,
          reason: event.reason,
          traceId: event.trace_id,
        })),
      ],
    };
  }

  /** Clear personal data of a connection document, for the auditor, with a reason; audited. */
  async reveal(principal: Principal, fileId: string, reason: string) {
    const row = await this.visible(principal, fileId);
    if (!can(principal.activeRole, 'reveal_pii')) {
      throw new AppError(403, 'FORBIDDEN', 'Doar auditorul poate vedea datele personale.');
    }
    if (!row.pii_encrypted || !this.keyring) {
      throw new AppError(404, 'NOT_FOUND', 'Fișierul nu are date personale.');
    }
    const pii = openPii(row.pii_encrypted, this.keyring);
    await this.audit.record(this.db, {
      actor: principal.username,
      actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
      demo: principal.activeRole !== principal.role,
      action: 'reveal_pii',
      outcome: 'success',
      category: row.category,
      fileId: row.id,
      reason,
    });
    const event = await this.db
      .selectFrom('audit_log')
      .select('id')
      .where('file_id', '=', row.id)
      .where('action', '=', 'reveal_pii')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    return {
      fileId: row.id,
      applicantName: pii.applicantName,
      cnp: pii.cnp,
      address: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      auditEventId: event.id,
    };
  }
}
