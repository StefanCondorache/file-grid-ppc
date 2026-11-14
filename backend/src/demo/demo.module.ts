import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { MetersModule } from '../meters/meters.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { KubeClient } from './kube.client';

@Module({
  imports: [FilesModule, MetersModule],
  controllers: [DemoController],
  providers: [DemoService, KubeClient],
})
export class DemoModule {}
