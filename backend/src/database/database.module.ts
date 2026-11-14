import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ROOT_LOGGER } from '../observability/logger';
import { DB, type Db, createDatabase } from './database';

@Injectable()
class DatabaseCloser implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (config: AppConfig, logger: Logger) => createDatabase(config, logger),
      inject: [APP_CONFIG, ROOT_LOGGER],
    },
    DatabaseCloser,
  ],
  exports: [DB],
})
export class DatabaseModule {}
