import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Category, StorageName } from '../common/domain';
import { DB, type Db } from '../database/database';
import type { SpanRow } from '../database/schema';
import { currentTrace } from './trace-context';

export interface OperationSummary {
  readonly operation: string;
  readonly category?: Category | null;
  readonly storage?: StorageName | null;
  readonly fileId?: string | null;
  readonly sizeBytes?: number | null;
  readonly status: 'ok' | 'error';
}

const STORAGE_NAMES = new Set(['s3', 'ftp', 'db']);

/**
 * Persists one row per traced operation (upload complete, download, meter batch...) with the spans
 * of the current trace, so GET /traces/{traceId} can show every step (policy, encryption, storage,
 * confirm) and the statistics can compare storages per category. Never fails the caller.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async record(summary: OperationSummary): Promise<void> {
    const trace = currentTrace();
    if (!trace) return;
    const spans: SpanRow[] = trace.spans.map((span, index) => {
      const storage = span.attrs.storage;
      return {
        spanId: String(index + 1),
        parentSpanId: null,
        name: span.name,
        startOffsetMs: Math.round(span.startMs * 100) / 100,
        durationMs: Math.round(span.durationMs * 100) / 100,
        status: span.status,
        storage:
          typeof storage === 'string' && STORAGE_NAMES.has(storage)
            ? (storage as StorageName)
            : null,
        errorCode: span.error ?? null,
      };
    });
    try {
      await this.db
        .insertInto('operations')
        .values({
          trace_id: trace.traceId,
          operation: summary.operation,
          category: summary.category ?? null,
          storage: summary.storage ?? null,
          file_id: summary.fileId ?? null,
          status: summary.status,
          started_at: new Date(Date.now() - trace.elapsedMs()),
          duration_ms: Math.round(trace.elapsedMs() * 100) / 100,
          size_bytes: summary.sizeBytes ?? null,
          spans: JSON.stringify(spans),
        })
        .execute();
    } catch (error) {
      this.logger.warn({
        message: 'could not record the operation trace',
        operation: summary.operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
