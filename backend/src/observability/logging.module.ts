import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ROOT_LOGGER, createRootLogger } from './logger';

@Global()
@Module({
  providers: [
    {
      provide: ROOT_LOGGER,
      useFactory: (config: AppConfig) => createRootLogger(config.logLevel),
      inject: [APP_CONFIG],
    },
  ],
  exports: [ROOT_LOGGER],
})
export class LoggingModule {}
