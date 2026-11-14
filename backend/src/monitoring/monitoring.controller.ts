import { Controller, Get, Module } from '@nestjs/common';
import { Authenticated, NoSessionRefresh } from '../auth/auth.decorators';
import { BulkheadService } from '../bulkhead/bulkhead.service';
import { CATEGORIES } from '../common/domain';
import { ObjectStoreService } from '../object-store/object-store.service';
import { storageHealthItems } from './storage-health';

/** Storage health strip and bulkhead state for the UI (live values of this replica). */
@Controller()
export class MonitoringController {
  constructor(
    private readonly store: ObjectStoreService,
    private readonly bulkhead: BulkheadService,
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
