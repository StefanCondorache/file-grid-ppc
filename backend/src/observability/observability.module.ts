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
import { Authenticated } from '../auth/auth.decorators';
import { AppError } from '../common/app-error';
import { CATEGORIES, ZONES } from '../common/domain';
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
    initAppMetrics(CATEGORIES, ZONES);
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(): Promise<string> {
    return register.metrics();
  }
}

const traceIdParam = new ZodPipe(z.string().regex(/^[A-Za-z0-9-]{1,64}$/));

/** GET /traces/{traceId}: every step of one operation, for the trace view of a file. */
@Controller('traces')
export class TracesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(':traceId')
  @Authenticated()
  async get(@Param('traceId', traceIdParam) traceId: string) {
    const row = await this.db
      .selectFrom('operations')
      .selectAll()
      .where('trace_id', '=', traceId)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Nu există o urmă cu acest ID.');
    return {
      traceId: row.trace_id,
      operation: row.operation,
      category: row.category,
      fileId: row.file_id,
      storage: row.storage,
      startedAt: row.started_at.toISOString(),
      durationMs: row.duration_ms,
      status: row.status,
      spans: row.spans,
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
