import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BulkheadModule } from './bulkhead/bulkhead.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DemoModule } from './demo/demo.module';
import { EventsModule } from './events/events.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';
import { MetersModule } from './meters/meters.module';
import { MonitoringModule } from './monitoring/monitoring.controller';
import { ObjectStoreModule } from './object-store/object-store.module';
import { LoggingModule } from './observability/logging.module';
import { ObservabilityModule } from './observability/observability.module';
import { PoliciesModule } from './policies/policies.module';
import { StatisticsModule } from './statistics/statistics.module';
import { StorageModule } from './storage/storage.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    StorageModule,
    ObjectStoreModule,
    ObservabilityModule,
    BulkheadModule,
    EventsModule,
    AuditModule,
    HealthModule,
    AuthModule,
    PoliciesModule,
    UploadsModule,
    FilesModule,
    MetersModule,
    MonitoringModule,
    StatisticsModule,
    DemoModule,
  ],
})
export class AppModule {}
