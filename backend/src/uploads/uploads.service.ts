import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/auth.types';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import { AppError } from '../common/app-error';
import { UPLOAD_CAPABILITY, can } from '../common/domain';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Keyring } from '../crypto/keys';
import { DB, type Db } from '../database/database';
import { maskCnp, maskName, sealPii } from '../files/pii';
import { KEYRING, ObjectStoreService } from '../object-store/object-store.service';
import { currentTraceId, span } from '../observability/trace-context';
import { PoliciesService } from '../policies/policies.service';
import { METADATA_KIND, type CreateUpload } from './upload.schemas';
import { type SessionRow, expectedPartSize, sessionView, statusView } from './upload.views';

export const stagingKey = (uploadId: string, part: number): string => `staging/${uploadId}/${part}`;

export function uploadNotFound(): AppError {
  return new AppError(404, 'UPLOAD_NOT_FOUND', 'Încărcarea nu există sau nu vă aparține.');
}

/** Passes the request body through and stops it once it exceeds `limit` bytes. */
async function* limited(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) {
      throw new AppError(413, 'PART_TOO_LARGE', 'Partea este mai mare decât dimensiunea anunțată.');
    }
    yield chunk;
  }
}

/**
 * Resumable chunked uploads (docs/api.md, ADR-0003). Stateless: the session and the list of
 * received parts live in Postgres and the part bytes in the policy's storage under
 * `staging/{uploadId}/{n}`, so any replica can take the next part or the completion.
 */
@Injectable()
export class UploadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEYRING) private readonly keyring: Keyring | null,
    private readonly policies: PoliciesService,
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
  ) {}

  async create(
    principal: Principal,
    idempotencyKey: string,
    body: CreateUpload,
  ): Promise<{ created: boolean; view: ReturnType<typeof sessionView> }> {
    if (!can(principal.activeRole, UPLOAD_CAPABILITY[body.category])) {
      throw new AppError(403, 'FORBIDDEN', 'Rolul activ nu poate încărca în această categorie.');
    }
    if (body.metadata.kind !== METADATA_KIND[body.category]) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Metadatele nu corespund categoriei.', {
        fieldErrors: [{ field: 'metadata.kind', code: 'invalid_value', message: 'Tip greșit.' }],
      });
    }
    const existing = await this.db
      .selectFrom('upload_sessions')
      .selectAll()
      .where('created_by', '=', principal.username)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return this.replay(existing, body);

    const policy = await span('policy', { category: body.category }, () =>
      this.policies.get(body.category),
    );
    if (body.fileSize > policy.maxFileSize) {
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        'Fișierul depășește dimensiunea maximă a politicii.',
        {
          maxFileSize: policy.maxFileSize,
        },
      );
    }
    if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(body.mimeType)) {
      throw new AppError(
        422,
        'TYPE_NOT_ALLOWED',
        'Tipul fișierului nu este permis pentru categorie.',
        {
          allowedTypes: policy.allowedTypes,
        },
      );
    }
    const { metadata, displayName, piiEncrypted, zone } = this.splitMetadata(body);
    const session = await this.db
      .insertInto('upload_sessions')
      .values({
        idempotency_key: idempotencyKey,
        category: body.category,
        file_name: body.fileName,
        display_name: displayName,
        mime_type: body.mimeType,
        file_size: body.fileSize,
        chunk_size: policy.chunkSize,
        part_count: Math.ceil(body.fileSize / policy.chunkSize),
        max_parallel: policy.maxParallel,
        policy_version: policy.version,
        encrypted: policy.encrypted,
        primary_storage: policy.primaryStorage,
        fallback_storage: policy.fallbackStorage,
        zone,
        metadata: JSON.stringify(metadata),
        pii_encrypted: piiEncrypted,
        created_by: principal.username,
        started_as_role: principal.activeRole,
        trace_id: currentTraceId() ?? 'none',
        expires_at: this.expiry(),
      })
      .onConflict((conflict) => conflict.columns(['created_by', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    // A concurrent create with the same key won the race: answer like a replay.
    if (!session) return this.create(principal, idempotencyKey, body);
    return { created: true, view: sessionView(session, [], policy.maxFileSize) };
  }

  async status(principal: Principal, uploadId: string) {
    const session = await this.expireIfDue(await this.owned(principal, uploadId));
    return statusView(session, await this.parts(uploadId));
  }

  async receivePart(
    principal: Principal,
    uploadId: string,
    part: number,
    body: AsyncIterable<Uint8Array>,
    declaredLength: number | undefined,
    declaredSha256: string | undefined,
  ) {
    const session = await this.expireIfDue(await this.owned(principal, uploadId));
    this.requireOpen(session);
    if (part < 1 || part > session.part_count) {
      throw new AppError(
        422,
        'PART_NUMBER_OUT_OF_RANGE',
        'Numărul părții este în afara intervalului.',
        {
          partCount: session.part_count,
        },
      );
    }
    const expected = expectedPartSize(session, part);
    if (declaredLength !== undefined && declaredLength !== expected) {
      throw new AppError(422, 'PART_SIZE_MISMATCH', 'Dimensiunea părții nu este cea așteptată.', {
        expectedSize: expected,
      });
    }
    const previous = await this.db
      .selectFrom('upload_parts')
      .selectAll()
      .where('upload_id', '=', uploadId)
      .where('part_number', '=', part)
      .executeTakeFirst();
    if (previous && declaredSha256 !== undefined && previous.sha256 === declaredSha256) {
      return {
        partNumber: part,
        size: previous.size_bytes,
        sha256: previous.sha256,
        alreadyReceived: true,
      };
    }
    const policy = await this.policies.get(session.category);
    const key = stagingKey(uploadId, part);
    const placement = {
      primary: session.primary_storage,
      fallback: session.fallback_storage,
      encrypted: session.encrypted,
    };
    const written = await this.bulkhead.run(session.category, policy.maxConcurrency, () =>
      this.store.writeOnce(session.category, key, placement, limited(body, expected)),
    );
    const problem =
      written.plain.size !== expected
        ? new AppError(422, 'PART_SIZE_MISMATCH', 'Dimensiunea părții nu este cea așteptată.', {
            expectedSize: expected,
            actualSize: written.plain.size,
          })
        : declaredSha256 !== undefined && declaredSha256 !== written.plain.sha256
          ? new AppError(422, 'PART_CHECKSUM_MISMATCH', 'Suma de control a părții nu coincide.', {
              expectedSha256: declaredSha256,
              actualSha256: written.plain.sha256,
            })
          : null;
    if (problem) {
      await this.store.delete(session.category, written.storage, key);
      throw problem;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('upload_parts')
        .values({
          upload_id: uploadId,
          part_number: part,
          size_bytes: written.plain.size,
          sha256: written.plain.sha256,
          storage: written.storage,
          storage_key: key,
        })
        .onConflict((conflict) =>
          conflict.columns(['upload_id', 'part_number']).doUpdateSet({
            size_bytes: written.plain.size,
            sha256: written.plain.sha256,
            storage: written.storage,
            received_at: new Date(),
          }),
        )
        .execute();
      await trx
        .updateTable('upload_sessions')
        .set({ updated_at: new Date(), expires_at: this.expiry() })
        .where('id', '=', uploadId)
        .execute();
    });
    if (previous && previous.storage !== written.storage) {
      await this.store.delete(session.category, previous.storage, key);
    }
    return {
      partNumber: part,
      size: written.plain.size,
      sha256: written.plain.sha256,
      alreadyReceived: false,
    };
  }

  async abort(principal: Principal, uploadId: string): Promise<void> {
    const session = await this.owned(principal, uploadId);
    if (session.status === 'completed') {
      throw new AppError(409, 'UPLOAD_COMPLETED', 'Încărcarea este deja finalizată.');
    }
    await this.db
      .updateTable('upload_sessions')
      .set({ status: 'aborted', updated_at: new Date() })
      .where('id', '=', uploadId)
      .execute();
    await this.dropStaging(session);
  }

  /** Best-effort removal of the staged parts (after completion or abort). */
  async dropStaging(session: SessionRow): Promise<void> {
    const parts = await this.parts(session.id);
    await Promise.all(
      parts.map((p) => this.store.delete(session.category, p.storage, p.storage_key)),
    );
  }

  async owned(principal: Principal, uploadId: string): Promise<SessionRow> {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw uploadNotFound();
    const session = await this.db
      .selectFrom('upload_sessions')
      .selectAll()
      .where('id', '=', uploadId)
      .executeTakeFirst();
    // Bound to the real user, not the acting role: a role switch never breaks a running upload.
    if (!session || session.created_by !== principal.username) throw uploadNotFound();
    return session;
  }

  parts(uploadId: string) {
    return this.db
      .selectFrom('upload_parts')
      .selectAll()
      .where('upload_id', '=', uploadId)
      .orderBy('part_number')
      .execute();
  }

  requireOpen(session: SessionRow): void {
    if (session.status === 'open') return;
    if (session.status === 'completed') {
      throw new AppError(409, 'UPLOAD_COMPLETED', 'Încărcarea este deja finalizată.');
    }
    throw new AppError(409, 'UPLOAD_NOT_OPEN', 'Încărcarea nu mai acceptă părți.', {
      status: session.status,
    });
  }

  private async expireIfDue(session: SessionRow): Promise<SessionRow> {
    if (session.status !== 'open' || session.expires_at.getTime() > Date.now()) return session;
    await this.db
      .updateTable('upload_sessions')
      .set({ status: 'expired' })
      .where('id', '=', session.id)
      .where('status', '=', 'open')
      .execute();
    return { ...session, status: 'expired' };
  }

  private async replay(existing: SessionRow, body: CreateUpload) {
    const same =
      existing.category === body.category &&
      Number(existing.file_size) === body.fileSize &&
      existing.file_name === body.fileName;
    if (!same) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Cheia de idempotență a fost folosită pentru alt fișier.',
      );
    }
    const parts = await this.parts(existing.id);
    const policy = await this.policies.get(existing.category);
    return {
      created: false,
      view: sessionView(
        existing,
        parts.map((p) => p.part_number),
        policy.maxFileSize,
      ),
    };
  }

  private splitMetadata(body: CreateUpload) {
    const m = body.metadata;
    if (m.kind === 'connection') {
      if (!this.keyring) {
        throw new AppError(503, 'ENCRYPTION_UNAVAILABLE', 'Cheia de criptare nu este configurată.');
      }
      const { applicantName, cnp, ...rest } = m;
      return {
        metadata: {
          ...rest,
          applicantNameMasked: maskName(applicantName),
          cnpMasked: maskCnp(cnp),
        },
        displayName: `Document racordare ${m.requestNumber} (${m.documentType})`,
        piiEncrypted: sealPii({ applicantName, cnp }, this.keyring),
        zone: m.zone ?? null,
      };
    }
    return { metadata: m, displayName: body.fileName, piiEncrypted: null, zone: m.zone };
  }

  private expiry(): Date {
    return new Date(Date.now() + this.config.uploadSessionTtlHours * 3_600_000);
  }
}
