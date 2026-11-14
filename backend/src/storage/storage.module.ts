import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../observability/logger';
import { StorageSettings } from './config';
import { StorageRegistry } from './registry';

export const STORAGE_REGISTRY = Symbol('STORAGE_REGISTRY');

/** Starts the health monitor after boot (never fatal: one storage down must not stop the app). */
@Injectable()
class StorageLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(STORAGE_REGISTRY) private readonly registry: StorageRegistry,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.registry.start();
    } catch (error) {
      this.logger.error({ err: error }, 'storage registry start failed');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.registry.close();
  }
}

/** The storage registry built from the environment (src/storage/config.ts lists the variables). */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_REGISTRY,
      useFactory: (logger: Logger) =>
        StorageRegistry.fromSettings(
          StorageSettings.fromEnv(process.env),
          logger.child({ component: 'storage' }),
        ),
      inject: [ROOT_LOGGER],
    },
    StorageLifecycle,
  ],
  exports: [STORAGE_REGISTRY],
})
export class StorageModule {}
