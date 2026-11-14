import { Controller, Get, Module } from '@nestjs/common';
import { Authenticated } from '../auth/auth.decorators';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import { CATEGORIES, STORAGES } from '../common/domain';
import { ObjectStoreService } from '../object-store/object-store.service';

/** Storage health strip and bulkhead state for the UI (live values of this replica). */
@Controller()
export class MonitoringController {
  constructor(
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
  ) {}

  @Get('storage-health')
  @Authenticated()
  storageHealth() {
    const status = this.store.status();
    return {
      data: STORAGES.map((storage) => {
        const s = status[storage];
        return {
          storage,
          status: s.up === false ? 'down' : s.circuit === 'closed' ? 'ok' : 'degraded',
          latencyMs: s.latencyMs,
          lastCheckAt: s.lastCheckAt ?? new Date().toISOString(),
          circuitState: s.circuit,
        };
      }),
    };
  }

  @Get('metrics/bulkhead')
  @Authenticated('view_observability')
  bulkheadState() {
    const snapshot = this.bulkhead.snapshot();
    return {
      data: CATEGORIES.map((category) => ({
        category,
        active: snapshot[category]?.active ?? 0,
        queued: snapshot[category]?.queued ?? 0,
      })),
    };
  }
}

@Module({ controllers: [MonitoringController] })
export class MonitoringModule {}
