import {
  Controller,
  Get,
  Global,
  Header,
  Inject,
  Module,
  type OnModuleInit,
  Param,
} from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { CATEGORIES, STORAGES, VIEW_CAPABILITY, ZONES, can } from '../common/domain';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../database/database';
import { initAppMetrics } from './app-metrics';
import { OperationsService } from './operations.service';

let defaultMetricsStarted = false;

/** Prometheus scrape endpoint, outside /api (Prometheus scrapes the pod directly). */
@Controller()
export class MetricsController implements OnModuleInit {
  onModuleInit(): void {
    if (!defaultMetricsStarted) {
      collectDefaultMetrics({ prefix: 'filegrid_backend_' });
      defaultMetricsStarted = true;
    }
    initAppMetrics(CATEGORIES, ZONES, STORAGES);
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  // Without it Express sends text/html, and Prometheus 3 rejects the scrape (unsupported Content-Type).
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}

const traceIdParam = new ZodPipe(z.string().regex(/^[A-Za-z0-9-]{1,64}$/));

const traceNotFound = (): AppError =>
  new AppError(404, 'NOT_FOUND', 'Nu există o urmă cu acest ID.');

/**
 * GET /traces/{traceId}: every step of one operation, for the trace view of a file. A role that may
 * not see the category of the operation gets the same 404 as for a trace that does not exist.
 */
@Controller('traces')
export class TracesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(':traceId')
  @Authenticated()
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('traceId', traceIdParam) traceId: string,
  ) {
    const row = await this.db
      .selectFrom('operations')
      .selectAll()
      .where('trace_id', '=', traceId)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) throw traceNotFound();
    if (row.category && !can(principal.activeRole, VIEW_CAPABILITY[row.category])) {
      throw traceNotFound();
    }
    return {
      traceId: row.trace_id,
      operation: row.operation,
      category: row.category,
      fileId: row.file_id,
      storage: row.storage,
      startedAt: row.started_at.toISOString(),
      durationMs: row.duration_ms,
      status: row.status,
      spans: row.spans.map((span) => ({ ...span, attributes: span.attributes ?? {} })),
    };
  }
}

@Global()
@Module({
  controllers: [MetricsController, TracesController],
  providers: [OperationsService],
  exports: [OperationsService],
})
export class ObservabilityModule {}
