import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.types';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import { AppError, failedStorage } from '../common/app-error';
import type { Keyring } from '../crypto/keys';
import { decryptStream } from '../crypto/envelope';
import { VIEW_CAPABILITY } from '../common/domain';
import { DB, type Db } from '../database/database';
import { EventBus } from '../events/event-bus.service';
import { KEYRING, ObjectStoreService } from '../object-store/object-store.service';
import { UPLOAD_DURATION, UPLOADS_TOTAL } from '../observability/app-metrics';
import { OperationsService } from '../observability/operations.service';
import { annotate, currentTraceId, span } from '../observability/trace-context';
import { PoliciesService } from '../policies/policies.service';
import { HashingStream, IntegrityError } from '../storage/base';
import type { CompleteUpload } from './upload.schemas';
import { type SessionRow, missingParts, toRanges } from './upload.views';
import { UploadsService } from './uploads.service';

/** How long POST /complete waits for the assembly before answering 202 + Retry-After. */
const COMPLETE_WAIT_MS = 8000;
/** A `verifying` session older than this lost its worker (pod restart): another one may take over. */
const STALE_VERIFYING_MS = 5 * 60_000;

type PartRow = Awaited<ReturnType<UploadsService['parts']>>[number];

export type CompleteOutcome =
  | { readonly kind: 'done'; readonly result: Record<string, unknown> }
  | { readonly kind: 'verifying' };

export function finalKey(category: string, fileId: string, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${category}/${y}/${m}/${d}/${fileId}.bin`;
}

/**
 * POST /uploads/{id}/complete: reads the staged parts back in order, hashes the whole file, writes
 * it to the policy's storage (fallback when the primary is down; encrypted when the policy says so)
 * and confirms the file only after the write is durable AND the server hash equals the client's.
 */
@Injectable()
export class UploadAssembler {
  private readonly logger = new Logger(UploadAssembler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KEYRING) private readonly keyring: Keyring | null,
    private readonly uploads: UploadsService,
    private readonly policies: PoliciesService,
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
    private readonly audit: AuditService,
    private readonly operations: OperationsService,
    private readonly events: EventBus,
  ) {}

  async complete(
    principal: Principal,
    uploadId: string,
    body: CompleteUpload,
  ): Promise<CompleteOutcome> {
    const session = await this.uploads.owned(principal, uploadId);
    annotate({ uploadId });
    if (session.status === 'completed' && session.result)
      return { kind: 'done', result: session.result };
    if (!['open', 'verifying'].includes(session.status)) this.uploads.requireOpen(session);
    if (body.partCount !== session.part_count) {
      throw new AppError(422, 'PART_COUNT_MISMATCH', 'Numărul de părți nu corespunde încărcării.', {
        partCount: session.part_count,
      });
    }
    const parts = await this.uploads.parts(uploadId);
    const missing = missingParts(
      session.part_count,
      parts.map((p) => p.part_number),
    );
    if (missing.length > 0) {
      throw new AppError(409, 'PARTS_MISSING', 'Lipsesc părți din încărcare.', {
        missingRanges: toRanges(missing),
      });
    }
    const claimed = await this.db
      .updateTable('upload_sessions')
      .set({ status: 'verifying', client_sha256: body.sha256, updated_at: new Date(), error: null })
      .where('id', '=', uploadId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'open'),
          eb.and([
            eb('status', '=', 'verifying'),
            eb('updated_at', '<', new Date(Date.now() - STALE_VERIFYING_MS)),
          ]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (!claimed) return { kind: 'verifying' };

    const work = this.finalize(claimed, parts, principal);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(resolve, COMPLETE_WAIT_MS, 'timeout').unref(),
    );
    const first = await Promise.race([work, timeout]);
    if (first === 'timeout') {
      work.catch(() => undefined); // the outcome is stored on the session; the client polls it
      return { kind: 'verifying' };
    }
    return { kind: 'done', result: first };
  }

  private async finalize(
    session: SessionRow,
    parts: readonly PartRow[],
    principal: Principal,
  ): Promise<Record<string, unknown>> {
    const started = performance.now();
    const fileId = randomUUID();
    const key = finalKey(session.category, fileId);
    const placement = {
      primary: session.primary_storage,
      fallback: session.fallback_storage,
      encrypted: session.encrypted,
    };
    const finish = (outcome: string) => {
      const seconds = (performance.now() - started) / 1000;
      UPLOADS_TOTAL.labels(session.category, outcome).inc();
      UPLOAD_DURATION.labels(session.category, outcome).observe(seconds);
    };
    try {
      const policy = await span('policy', { category: session.category }, () =>
        this.policies.get(session.category),
      );
      const written = await this.bulkhead.run(session.category, policy.maxConcurrency, () =>
        this.store.write(session.category, key, placement, () => this.readParts(session, parts)),
      );
      const base = {
        clientSha256: session.client_sha256,
        serverSha256: written.plain.sha256,
        size: written.plain.size,
        storage: written.storage,
        usedFallback: written.usedFallback,
        policyVersion: session.policy_version,
        encryptedAtRest: session.encrypted,
        traceId: currentTraceId() ?? session.trace_id,
      };
      if (written.plain.sha256 !== session.client_sha256) {
        await this.store.delete(session.category, written.storage, key);
        const result = { ...base, status: 'failed', verdict: 'mismatch', fileId: null };
        await this.fail(
          session,
          result,
          'FILE_CHECKSUM_MISMATCH',
          'Suma de control a fișierului nu coincide.',
          principal,
        );
        finish('mismatch');
        this.announce(session, result);
        return result;
      }
      const availableAfterMs = Math.round(performance.now() - started);
      const result = {
        ...base,
        status: 'completed',
        verdict: 'match',
        fileId,
        availableAt: new Date().toISOString(),
        availableAfterMs,
      };
      await span('confirm', {}, () =>
        this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('files')
            .values({
              id: fileId,
              category: session.category,
              display_name: session.display_name,
              mime_type: session.mime_type,
              size_bytes: written.plain.size,
              sha256: written.plain.sha256,
              client_sha256: session.client_sha256,
              storage: written.storage,
              storage_key: key,
              stored_size_bytes: written.stored.size,
              stored_sha256: written.stored.sha256,
              encrypted: session.encrypted,
              used_fallback: written.usedFallback,
              integrity: 'verified',
              policy_version: session.policy_version,
              zone: session.zone,
              origin: 'manual',
              metadata: JSON.stringify(session.metadata),
              pii_encrypted: session.pii_encrypted,
              uploaded_by: session.created_by,
              upload_trace_id: base.traceId,
              upload_started_at: session.created_at,
            })
            .execute();
          await trx
            .updateTable('upload_sessions')
            .set({
              status: 'completed',
              result: JSON.stringify(result),
              file_id: fileId,
              updated_at: new Date(),
            })
            .where('id', '=', session.id)
            .execute();
          await this.audit.record(trx, {
            actor: principal.username,
            actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
            action: 'upload',
            outcome: 'success',
            category: session.category,
            fileId,
            details: `${written.storage}${written.usedFallback ? ' (fallback)' : ''}, ${written.plain.size} B`,
          });
        }),
      );
      finish('success');
      this.announce(session, result);
      await this.operations.record({
        operation: 'upload.complete',
        category: session.category,
        storage: written.storage,
        fileId,
        sizeBytes: written.plain.size,
        status: 'ok',
      });
      void this.uploads.dropStaging(session);
      return result;
    } catch (error) {
      finish('error');
      await this.reopen(session, error);
      await this.operations.record({
        operation: 'upload.complete',
        category: session.category,
        storage: failedStorage(error),
        status: 'error',
      });
      throw error;
    }
  }

  /** Live events: the uploader learns the verdict; everyone who sees the category, the new file. */
  private announce(session: SessionRow, result: Record<string, unknown>): void {
    this.events.publish(
      'upload.verified',
      {
        uploadId: session.id,
        fileId: result.fileId ?? null,
        verdict: result.verdict,
        serverSha256: result.serverSha256,
        availableAfterMs: result.availableAfterMs ?? null,
      },
      { username: session.created_by },
    );
    if (result.verdict !== 'match') return;
    const metadata = session.metadata as Record<string, unknown>;
    this.events.publish(
      'file.created',
      {
        fileId: result.fileId,
        category: session.category,
        zone: session.zone,
        severity: typeof metadata.severity === 'string' ? metadata.severity : null,
        substation: typeof metadata.substation === 'string' ? metadata.substation : null,
        origin: 'manual',
        createdAt: result.availableAt,
        availableAt: result.availableAt,
      },
      { capability: VIEW_CAPABILITY[session.category] },
    );
  }

  /** The staged parts in order, decrypted, each checked against the hash recorded when it arrived. */
  private async *readParts(session: SessionRow, parts: readonly PartRow[]): AsyncGenerator<Buffer> {
    for (const part of parts) {
      const raw = this.store.readRaw(session.category, part.storage, part.storage_key);
      const plain = new HashingStream(
        session.encrypted && this.keyring ? decryptStream(raw, this.keyring) : raw,
      );
      for await (const chunk of plain) yield chunk;
      if (plain.sha256 !== part.sha256) {
        throw new PartCorrupted(part.part_number);
      }
    }
  }

  private async fail(
    session: SessionRow,
    result: Record<string, unknown>,
    code: string,
    message: string,
    principal: Principal,
  ): Promise<void> {
    await this.db
      .updateTable('upload_sessions')
      .set({
        status: 'failed',
        result: JSON.stringify(result),
        error: JSON.stringify({ code, message }),
        updated_at: new Date(),
      })
      .where('id', '=', session.id)
      .execute();
    await this.audit.record(this.db, {
      actor: principal.username,
      action: 'upload',
      outcome: 'failure',
      category: session.category,
      details: code,
    });
    void this.uploads.dropStaging(session);
  }

  /** A retryable failure: the session goes back to `open` so the client can resend and complete. */
  private async reopen(session: SessionRow, error: unknown): Promise<void> {
    const corrupted = error instanceof PartCorrupted;
    const code = corrupted
      ? 'PART_CORRUPTED'
      : error instanceof AppError
        ? error.code
        : error instanceof IntegrityError
          ? 'PART_CORRUPTED'
          : 'INTERNAL_ERROR';
    try {
      await this.db.transaction().execute(async (trx) => {
        if (corrupted) {
          await trx
            .deleteFrom('upload_parts')
            .where('upload_id', '=', session.id)
            .where('part_number', '=', error.part)
            .execute();
        }
        await trx
          .updateTable('upload_sessions')
          .set({
            status: 'open',
            error: JSON.stringify({ code, message: 'Finalizarea nu a reușit; reîncercați.' }),
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', session.id)
          .execute();
      });
    } catch (reopenError) {
      this.logger.error({
        message: 'could not reopen an upload after a failed completion',
        uploadId: session.id,
        error: reopenError instanceof Error ? reopenError.message : String(reopenError),
      });
    }
  }
}

class PartCorrupted extends AppError {
  constructor(readonly part: number) {
    super(409, 'PART_CORRUPTED', 'O parte stocată temporar este coruptă; retrimiteți-o.', {
      missingRanges: [[part, part]],
    });
  }
}
