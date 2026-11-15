import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Category, StorageName } from '../common/domain';
import { DB, type Db } from '../database/database';
import type { SpanRow } from '../database/schema';
import { type SpanAttributes, type SpanRecord, currentTrace } from './trace-context';

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
 * The span attributes a trace may show. Everything else stays in memory: no metadata, no personal
 * data, no query strings ever reach the operations table.
 */
const SHOWN_ATTRIBUTES = new Set([
  'method',
  'path',
  'uploadId',
  'partNumber',
  'category',
  'storage',
  'encrypted',
  'sizeBytes',
  'algorithm',
  'keyId',
  'action',
  'outcome',
]);

function shown(attrs: SpanAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!SHOWN_ATTRIBUTES.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

function storageOf(attrs: SpanAttributes): StorageName | null {
  const storage = attrs.storage;
  return typeof storage === 'string' && STORAGE_NAMES.has(storage)
    ? (storage as StorageName)
    : null;
}

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
    // The root span is the request itself (API); every recorded step is its child, in the order
    // the steps finished (policy, encryption, storage, audit...).
    const root: SpanRow = {
      spanId: '1',
      parentSpanId: null,
      name: 'api',
      startOffsetMs: 0,
      durationMs: round(trace.elapsedMs()),
      status: summary.status,
      storage: summary.storage ?? null,
      errorCode: null,
      attributes: shown(trace.attributes),
    };
    const steps = trace.spans.map((span: SpanRecord, index): SpanRow => ({
      spanId: String(index + 2),
      parentSpanId: '1',
      name: span.name,
      startOffsetMs: round(Math.max(0, span.startMs)),
      durationMs: round(span.durationMs),
      status: span.status,
      storage: storageOf(span.attrs),
      errorCode: span.error ?? null,
      attributes: shown(span.attrs),
    }));
    const spans = [root, ...steps];
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
          duration_ms: root.durationMs,
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
