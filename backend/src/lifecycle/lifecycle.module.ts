import { Global, Module } from '@nestjs/common';
import { BootService } from './boot.service';
import { Lifecycle } from './lifecycle';

/** Readiness state, the start-up work that needs the database, and the shutdown drain. */
@Global()
@Module({ providers: [Lifecycle, BootService], exports: [Lifecycle, BootService] })
export class LifecycleModule {}
