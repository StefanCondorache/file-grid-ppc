import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import type { Zone } from '../common/domain';
import { DB, type Db } from '../database/database';
import { ObjectStoreService } from '../object-store/object-store.service';
import { METER_BATCHES, METER_DUPLICATES, METER_STORED } from '../observability/app-metrics';
import { OperationsService } from '../observability/operations.service';
import { currentTraceId, span } from '../observability/trace-context';
import { PoliciesService } from '../policies/policies.service';
import type { Reading, ReadingBatch, ReadingQuery } from './meters.schemas';

export interface BatchResult {
  readonly received: number;
  readonly stored: number;
  readonly duplicates: number;
  readonly traceId: string;
}

function batchKey(fileId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '/');
  return `meter_readings/${day}/${fileId}.jsonl`;
}

function countByZone(readings: readonly Reading[]): Map<Zone, number> {
  const counts = new Map<Zone, number>();
  for (const r of readings) counts.set(r.zone, (counts.get(r.zone) ?? 0) + 1);
  return counts;
}

/**
 * Meter readings (TASKS P2.5). Idempotent on `readingId`: a retried or duplicated reading is
 * recognised and acknowledged without being stored again (the primary key makes a double insert
 * impossible even when two replicas race). Each batch of new readings is also kept as one JSONL
 * object in the policy's storage (db, fallback s3), so meter data follows the policy engine too.
 */
@Injectable()
export class MetersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly policies: PoliciesService,
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
    private readonly operations: OperationsService,
  ) {}

  async ingest(batch: ReadingBatch, keyId: string): Promise<BatchResult> {
    const traceId = currentTraceId() ?? 'none';
    const policy = await span('policy', { category: 'meter_readings' }, () =>
      this.policies.get('meter_readings'),
    );
    try {
      const result = await this.bulkhead.run('meter_readings', policy.maxConcurrency, () =>
        this.store_(batch.readings, policy, keyId, traceId),
      );
      METER_BATCHES.labels('success').inc();
      return result;
    } catch (error) {
      METER_BATCHES.labels('error').inc();
      await this.operations.record({
        operation: 'meter.batch',
        category: 'meter_readings',
        status: 'error',
      });
      throw error;
    }
  }

  private async store_(
    readings: readonly Reading[],
    policy: Awaited<ReturnType<PoliciesService['get']>>,
    keyId: string,
    traceId: string,
  ): Promise<BatchResult> {
    const unique = [...new Map(readings.map((r) => [r.readingId, r])).values()];
    const known = await this.db
      .selectFrom('meter_readings')
      .select('reading_id')
      .where(
        'reading_id',
        'in',
        unique.map((r) => r.readingId),
      )
      .execute();
    const knownIds = new Set(known.map((row) => row.reading_id));
    const fresh = unique.filter((r) => !knownIds.has(r.readingId));
    const origin = readings.some((r) => r.origin === 'storm') ? 'storm' : readings[0].origin;
    if (fresh.length === 0) {
      return this.finish(readings, [], null, origin, traceId);
    }
    const fileId = randomUUID();
    const key = batchKey(fileId);
    const body = Buffer.from(`${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const written = await this.store.write(
      'meter_readings',
      key,
      {
        primary: policy.primaryStorage,
        fallback: policy.fallbackStorage,
        encrypted: policy.encrypted,
      },
      async function* () {
        yield body;
      },
    );
    const stored = await span('confirm', {}, () =>
      this.db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('meter_readings')
          .values(
            fresh.map((r) => ({
              reading_id: r.readingId,
              meter_id: r.meterId,
              zone: r.zone,
              reading_time: r.readingTime,
              kwh: r.kwh,
              sequence: r.sequence,
              origin: r.origin,
              file_id: fileId,
              trace_id: traceId,
            })),
          )
          .onConflict((conflict) => conflict.column('reading_id').doNothing())
          .returning(['reading_id', 'zone'])
          .execute();
        if (inserted.length === 0) return inserted; // a concurrent retry stored them first
        await trx
          .insertInto('files')
          .values({
            id: fileId,
            category: 'meter_readings',
            display_name: `Citiri contoare ${new Date().toISOString().slice(0, 19)}Z (${inserted.length})`,
            mime_type: 'application/x-ndjson',
            size_bytes: written.plain.size,
            sha256: written.plain.sha256,
            storage: written.storage,
            storage_key: key,
            stored_size_bytes: written.stored.size,
            stored_sha256: written.stored.sha256,
            encrypted: policy.encrypted,
            used_fallback: written.usedFallback,
            integrity: 'server_verified',
            policy_version: policy.version,
            zone: fresh[0].zone,
            origin,
            metadata: JSON.stringify({ kind: 'meter_batch', readings: inserted.length }),
            uploaded_by: `meter:${keyId}`,
            upload_trace_id: traceId,
          })
          .execute();
        return inserted;
      }),
    );
    const storedIds = new Set(stored.map((row) => row.reading_id));
    if (stored.length === 0) await this.store.delete('meter_readings', written.storage, key);
    const storedReadings = fresh.filter((r) => storedIds.has(r.readingId));
    return this.finish(
      readings,
      storedReadings,
      stored.length > 0 ? fileId : null,
      origin,
      traceId,
      written.storage,
    );
  }

  private async finish(
    received: readonly Reading[],
    stored: readonly Reading[],
    fileId: string | null,
    origin: Reading['origin'],
    traceId: string,
    storage: Awaited<ReturnType<ObjectStoreService['write']>>['storage'] | null = null,
  ): Promise<BatchResult> {
    const storedIds = new Set(stored.map((r) => r.readingId));
    // Each received reading that was not stored now is a duplicate (a retry, or repeated in the batch).
    const duplicates = received.filter((r, index) => {
      if (!storedIds.has(r.readingId)) return true;
      return received.findIndex((other) => other.readingId === r.readingId) !== index;
    });
    for (const [zone, n] of countByZone(stored)) METER_STORED.labels(zone).inc(n);
    for (const [zone, n] of countByZone(duplicates)) METER_DUPLICATES.labels(zone).inc(n);
    await this.db
      .insertInto('meter_batches')
      .values({
        received: received.length,
        stored: stored.length,
        duplicates: duplicates.length,
        origin,
        file_id: fileId,
        trace_id: traceId,
      })
      .execute();
    await this.operations.record({
      operation: 'meter.batch',
      category: 'meter_readings',
      storage,
      fileId,
      sizeBytes: stored.length,
      status: 'ok',
    });
    return {
      received: received.length,
      stored: stored.length,
      duplicates: duplicates.length,
      traceId,
    };
  }

  async list(query: ReadingQuery) {
    let base = this.db
      .selectFrom('meter_readings')
      .innerJoin('files', 'files.id', 'meter_readings.file_id');
    if (query.zone) base = base.where('meter_readings.zone', '=', query.zone);
    if (query.meterId) base = base.where('meter_readings.meter_id', '=', query.meterId);
    if (query.origin) base = base.where('meter_readings.origin', '=', query.origin);
    const rows = await base
      .select([
        'meter_readings.file_id',
        'meter_readings.meter_id',
        'meter_readings.zone',
        'meter_readings.reading_time',
        'meter_readings.kwh',
        'meter_readings.sequence',
        'meter_readings.received_at',
        'meter_readings.origin',
        'files.storage',
      ])
      .orderBy('meter_readings.received_at', 'desc')
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const total = await this.db
      .selectFrom('meter_readings')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    return {
      data: rows.slice(0, query.pageSize).map((row) => ({
        fileId: row.file_id,
        meterId: row.meter_id,
        zone: row.zone,
        readingTime: row.reading_time.toISOString(),
        kwh: Number(row.kwh),
        sequence: Number(row.sequence),
        receivedAt: row.received_at.toISOString(),
        storage: row.storage,
        origin: row.origin,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: Number(total.n),
        totalIsEstimate: Boolean(query.zone || query.meterId || query.origin),
        hasMore: rows.length > query.pageSize,
      },
    };
  }

  /** Totals since the start, the rate over the last minute, and per zone. */
  async counters(lost: number | null) {
    const totals = await this.db
      .selectFrom('meter_batches')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<string>('received'), eb.lit(0)).as('received'),
        eb.fn.coalesce(eb.fn.sum<string>('duplicates'), eb.lit(0)).as('duplicates'),
      ])
      .executeTakeFirstOrThrow();
    const recent = await this.db
      .selectFrom('meter_readings')
      .select(['zone', (eb) => eb.fn.countAll<string>().as('n')])
      .where('received_at', '>', new Date(Date.now() - 60_000))
      .groupBy('zone')
      .execute();
    const byZone = await this.db
      .selectFrom('meter_readings')
      .select(['zone', (eb) => eb.fn.countAll<string>().as('n')])
      .groupBy('zone')
      .execute();
    const rateOf = (zone: string) => Number(recent.find((r) => r.zone === zone)?.n ?? 0) / 60;
    const unique = byZone.reduce((sum, row) => sum + Number(row.n), 0);
    return {
      received: Number(totals.received),
      unique,
      duplicatesRejected: Number(totals.duplicates),
      lost,
      ratePerS: Math.round((recent.reduce((sum, row) => sum + Number(row.n), 0) / 60) * 10) / 10,
      byZone: byZone.map((row) => ({
        zone: row.zone,
        received: Number(row.n),
        ratePerS: Math.round(rateOf(row.zone) * 10) / 10,
      })),
      at: new Date().toISOString(),
    };
  }
}
