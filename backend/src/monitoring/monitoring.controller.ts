import { Controller, Get, Module, Query } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, NoSessionRefresh } from '../auth/auth.decorators';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import { CATEGORIES } from '../common/domain';
import { ObjectStoreService } from '../object-store/object-store.service';
import { ZodPipe } from '../common/zod.pipe';
import {
  MATRIX_WINDOWS,
  type MatrixWindow,
  MetricsService,
  SERIES_WINDOWS,
  type SeriesWindow,
} from './metrics.service';
import { storageHealthItems } from './storage-health';

const matrixQuery = z.object({
  window: z.enum(Object.keys(MATRIX_WINDOWS) as [MatrixWindow]).default('5m'),
});
const seriesQuery = z.object({
  window: z.enum(Object.keys(SERIES_WINDOWS) as [SeriesWindow]).default('15m'),
});

/** Storage health strip, bulkhead state and the category x storage metrics for the UI. */
@Controller()
export class MonitoringController {
  constructor(
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('storage-health')
  @Authenticated()
  @NoSessionRefresh()
  storageHealth() {
    return { data: storageHealthItems(this.store.status()) };
  }

  @Get('metrics/bulkhead')
  @Authenticated('view_observability')
  @NoSessionRefresh()
  async bulkheadState(@Query(new ZodPipe(seriesQuery)) query: { window: SeriesWindow }) {
    const snapshot = this.bulkhead.snapshot();
    return {
      ...(await this.metrics.bulkheadSeries(query.window)),
      // Live state of this replica's compartments.
      data: CATEGORIES.map((category) => ({
        category,
        active: snapshot[category]?.active ?? 0,
        queued: snapshot[category]?.queued ?? 0,
      })),
    };
  }

  @Get('metrics/matrix')
  @Authenticated('view_observability')
  @NoSessionRefresh()
  matrix(@Query(new ZodPipe(matrixQuery)) query: { window: MatrixWindow }) {
    return this.metrics.matrix(query.window);
  }
}

@Module({ controllers: [MonitoringController], providers: [MetricsService] })
export class MonitoringModule {}
