import { once } from 'node:events';
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
/** At most this many buffered verifications at once (4 x 8 MiB), the rest are streamed. */
const MAX_BUFFERED_DOWNLOADS = 4;
let bufferedDownloads = 0;

type Outcome = 'success' | 'corrupt' | 'aborted' | 'error';

export type ByteRange =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * One `Range: bytes=a-b` (also `a-` and `-n`) against a file of `size` bytes, end clamped to the
 * file. Other units and lists of ranges are ignored (the whole file is sent, as RFC 9110 allows);
 * anything else that cannot be served is `invalid` (416).
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const value = header?.trim();
  if (!value || !value.startsWith('bytes=') || value.includes(',')) return { kind: 'none' };
  const match = SINGLE_RANGE.exec(value);
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return { kind: 'invalid' };
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return { kind: 'invalid' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (start > end || start >= size) return { kind: 'invalid' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

export interface DownloadOptions {
  readonly range?: string;
  readonly ifRange?: string;
}

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

  async send(
    principal: Principal,
    fileId: string,
    response: Response,
    options: DownloadOptions = {},
  ): Promise<void> {
    const row = await this.files.visible(principal, fileId);
    if (row.integrity === 'corrupt') throw this.corrupt(row, null);
    const range = this.rangeOf(row, options);
    if (range.kind === 'range') return this.sendRange(principal, row, response, range);
    const buffered =
      Number(row.size_bytes) <= VERIFY_BEFORE_SEND_BYTES &&
      bufferedDownloads < MAX_BUFFERED_DOWNLOADS;
    const outcome = buffered
      ? await this.sendVerified(row, response)
      : await this.sendStreamed(row, response);
    DOWNLOADS_TOTAL.labels(row.category, outcome).inc();
    // Audit first, so the trace of the download shows its audit step.
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
    await this.operations.record({
      operation: 'file.download',
      category: row.category,
      storage: row.storage,
      fileId: row.id,
      sizeBytes: Number(row.size_bytes),
      status: outcome === 'success' ? 'ok' : 'error',
    });
  }

  private async sendVerified(row: FileRow, response: Response): Promise<Outcome> {
    bufferedDownloads += 1;
    try {
      return await this.verifyThenSend(row, response);
    } finally {
      bufferedDownloads -= 1;
    }
  }

  private async verifyThenSend(row: FileRow, response: Response): Promise<Outcome> {
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
    // Written chunk by chunk (no Buffer.concat): one copy of the file in memory, not two.
    response.status(200).set(this.headers(row)).set('Content-Length', String(plain.size));
    for (const chunk of chunks) response.write(chunk);
    response.end();
    return 'success';
  }

  private async sendStreamed(row: FileRow, response: Response): Promise<Outcome> {
    response.status(200).set(this.headers(row)).set('Content-Length', String(row.size_bytes));
    // A client that leaves aborts the storage read too, so its connection goes back at once.
    const gone = new AbortController();
    const onClose = (): void => {
      if (!response.writableFinished) gone.abort(new Error('client went away'));
    };
    response.once('close', onClose);
    const plain = new HashingStream(this.store.read(row.category, located(row), gone.signal));
    try {
      await span('storage.get', { storage: row.storage, category: row.category }, async () => {
        for await (const chunk of plain) {
          if (response.destroyed) throw new Error('client went away');
          if (!response.write(chunk)) await once(response, 'drain', { signal: gone.signal });
        }
      });
      if (plain.sha256 !== row.sha256) throw new IntegrityError('plaintext hash mismatch');
      response.end();
      return 'success';
    } catch (error) {
      const corrupt = isCorruption(error);
      if (corrupt) await this.files.markCorrupt(row, 'system:download');
      // Headers are sent: cutting the connection is the only honest signal of a bad file.
      response.destroy();
      this.logger.warn({
        message: 'download aborted',
        category: row.category,
        storage: row.storage,
        file_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return corrupt ? 'corrupt' : gone.signal.aborted ? 'aborted' : 'error';
    } finally {
      response.off('close', onClose);
    }
  }

  /** Byte ranges only for plain files (an encrypted file is decrypted and verified whole). */
  private rangeOf(row: FileRow, options: DownloadOptions): ByteRange {
    if (row.encrypted || options.range === undefined) return { kind: 'none' };
    if (options.ifRange !== undefined && options.ifRange !== `"${row.sha256}"`) {
      return { kind: 'none' };
    }
    const size = Number(row.size_bytes);
    const range = parseRange(options.range, size);
    if (range.kind === 'invalid') {
      throw new AppError(
        416,
        'RANGE_NOT_SATISFIABLE',
        'Intervalul de octeți cerut nu există în fișier.',
        { size },
        { 'Content-Range': `bytes */${size}` },
      );
    }
    return range;
  }

  /**
   * 206 with the bytes start..end, read from the start of the stored object and skipped up to
   * `start` (the storages have no ranged reads). No whole-file hash is checked for a part.
   */
  private async sendRange(
    principal: Principal,
    row: FileRow,
    response: Response,
    range: { start: number; end: number },
  ): Promise<void> {
    const length = range.end - range.start + 1;
    response
      .status(206)
      .set(this.headers(row))
      .set({
        'Content-Range': `bytes ${range.start}-${range.end}/${row.size_bytes}`,
        'Content-Length': String(length),
      });
    const gone = new AbortController();
    const onClose = (): void => {
      if (!response.writableFinished) gone.abort(new Error('client went away'));
    };
    response.once('close', onClose);
    let offset = 0;
    let outcome: Outcome = 'success';
    try {
      const chunks = this.store.readRaw(row.category, row.storage, row.storage_key, gone.signal);
      await span('storage.get', { storage: row.storage, category: row.category }, async () => {
        for await (const chunk of chunks) {
          const from = Math.max(0, range.start - offset);
          const to = Math.min(chunk.length, range.end + 1 - offset);
          offset += chunk.length;
          if (to <= from) {
            if (offset > range.end) break;
            continue;
          }
          if (!response.write(chunk.subarray(from, to))) {
            await once(response, 'drain', { signal: gone.signal });
          }
          if (offset > range.end) break; // stop reading: closes the storage connection
        }
      });
      response.end();
    } catch (error) {
      outcome = gone.signal.aborted ? 'aborted' : 'error';
      response.destroy();
      this.logger.warn({
        message: 'range download aborted',
        category: row.category,
        storage: row.storage,
        file_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      response.off('close', onClose);
    }
    DOWNLOADS_TOTAL.labels(row.category, outcome).inc();
    // A player seeks with many ranges: only the first one (from byte 0) is a custody event.
    if (outcome === 'success' && range.start === 0) {
      await this.audit.record(this.db, {
        actor: principal.username,
        actingAs: principal.activeRole === principal.role ? null : principal.activeRole,
        action: 'download',
        outcome: 'success',
        category: row.category,
        fileId: row.id,
        details: `range ${range.start}-${range.end}`,
      });
    }
    await this.operations.record({
      operation: 'file.download',
      category: row.category,
      storage: row.storage,
      fileId: row.id,
      sizeBytes: length,
      status: outcome === 'success' ? 'ok' : 'error',
    });
  }

  /** Set only once the bytes are known good (small files) or about to stream: errors stay JSON. */
  private headers(row: FileRow): Record<string, string> {
    return {
      'Content-Type': row.mime_type,
      'Content-Disposition': contentDisposition(row.display_name),
      'X-Content-Type-Options': 'nosniff',
      'X-File-SHA256': row.sha256,
      ETag: `"${row.sha256}"`,
      'Accept-Ranges': row.encrypted ? 'none' : 'bytes',
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
