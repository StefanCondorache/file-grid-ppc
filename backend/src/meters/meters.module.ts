import { Module } from '@nestjs/common';
import { PoliciesModule } from '../policies/policies.module';
import { MetersController } from './meters.controller';
import { MeterCountersPublisher } from './meter-counters.publisher';
import { MetersService } from './meters.service';
import { SimulatorClient } from './simulator.client';

@Module({
  imports: [PoliciesModule],
  controllers: [MetersController],
  providers: [MetersService, SimulatorClient, MeterCountersPublisher],
  exports: [MetersService, SimulatorClient],
})
export class MetersModule {}
