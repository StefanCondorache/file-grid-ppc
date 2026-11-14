import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { DB, type Db } from '../database/database';
import { ObjectStoreService } from '../object-store/object-store.service';
import { DOWNLOADS_TOTAL } from '../observability/app-metrics';
import { OperationsService } from '../observability/operations.service';
import { span } from '../observability/trace-context';
import { HashingStream, IntegrityError } from '../storage/base';
import { type FileRow, FilesService, located } from './files.service';

/** Files up to this size are verified completely before the first byte is sent (bounded: the pod has 384Mi). */
const VERIFY_BEFORE_SEND_BYTES = 8 * 1024 * 1024;

function isCorruption(error: unknown): boolean {
  return (
    error instanceof IntegrityError || (error instanceof Error && error.name === 'DecryptionError')
  );
}

/** `attachment; filename="..."; filename*=UTF-8''...` with anything unsafe removed. */
export function contentDisposition(name: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '_').slice(0, 200) || 'fisier';
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * GET /files/{id}/content. The SHA-256 is recomputed while reading: small files are verified
 * completely first, so a corruption is a clean 409 FILE_CORRUPT with both hashes; large files are
 * streamed and the connection is cut (never ended cleanly) if the hash turns out wrong at the end.
 * Either way the file is marked corrupt.
 */
@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly files: FilesService,
    private readonly store: ObjectStoreService,
    private readonly audit: AuditService,
    private readonly operations: OperationsService,
  ) {}

  async send(principal: Principal, fileId: string, response: Response): Promise<void> {
    const row = await this.files.visible(principal, fileId);
    if (row.integrity === 'corrupt') throw this.corrupt(row, null);
    const outcome =
      Number(row.size_bytes) <= VERIFY_BEFORE_SEND_BYTES
        ? await this.sendVerified(row, response)
        : await this.sendStreamed(row, response);
    DOWNLOADS_TOTAL.labels(row.category, outcome).inc();
    await this.operations.record({
      operation: 'file.download',
      category: row.category,
      storage: row.storage,
      fileId: row.id,
      sizeBytes: Number(row.size_bytes),
      status: outcome === 'success' ? 'ok' : 'error',
    });
    if (outcome === 'success') {
      await this.audit.record(this.db, {
        actor: principal.username,
        actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
        action: 'download',
        outcome: 'success',
        category: row.category,
        fileId: row.id,
      });
    }
  }

  private async sendVerified(row: FileRow, response: Response): Promise<'success'> {
    const plain = new HashingStream(this.store.read(row.category, located(row)));
    const chunks: Buffer[] = [];
    try {
      await span('storage.get', { storage: row.storage, category: row.category }, async () => {
        for await (const chunk of plain) chunks.push(chunk);
      });
    } catch (error) {
      if (!isCorruption(error)) throw error;
      await this.files.markCorrupt(row, 'system:download');
      throw this.corrupt(row, plain.sha256);
    }
    if (plain.sha256 !== row.sha256) {
      await this.files.markCorrupt(row, 'system:download');
      throw this.corrupt(row, plain.sha256);
    }
    const body = Buffer.concat(chunks);
    response
      .status(200)
      .set(this.headers(row))
      .set('Content-Length', String(body.length))
      .end(body);
    return 'success';
  }

  private async sendStreamed(row: FileRow, response: Response): Promise<'success' | 'corrupt'> {
    response.status(200).set(this.headers(row)).set('Content-Length', String(row.size_bytes));
    const plain = new HashingStream(this.store.read(row.category, located(row)));
    try {
      await span('storage.get', { storage: row.storage, category: row.category }, async () => {
        for await (const chunk of plain) {
          if (!response.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
              response.once('drain', resolve);
              response.once('close', () => reject(new Error('client went away')));
            });
          }
        }
      });
      if (plain.sha256 !== row.sha256) throw new IntegrityError('plaintext hash mismatch');
      response.end();
      return 'success';
    } catch (error) {
      if (isCorruption(error)) await this.files.markCorrupt(row, 'system:download');
      // Headers are sent: cutting the connection is the only honest signal of a bad file.
      response.destroy();
      this.logger.warn({
        message: 'download aborted',
        category: row.category,
        storage: row.storage,
        file_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'corrupt';
    }
  }

  /** Set only once the bytes are known good (small files) or about to stream: errors stay JSON. */
  private headers(row: FileRow): Record<string, string> {
    return {
      'Content-Type': row.mime_type,
      'Content-Disposition': contentDisposition(row.display_name),
      'X-Content-Type-Options': 'nosniff',
      'X-File-SHA256': row.sha256,
      ETag: `"${row.sha256}"`,
      'Cache-Control': 'private, no-store',
    };
  }

  private corrupt(row: FileRow, actual: string | null): AppError {
    DOWNLOADS_TOTAL.labels(row.category, 'corrupt').inc();
    return new AppError(
      409,
      'FILE_CORRUPT',
      'Fișierul stocat este corupt: suma de control nu mai coincide.',
      {
        expectedSha256: row.sha256,
        actualSha256: actual,
        storage: row.storage,
      },
    );
  }
}
