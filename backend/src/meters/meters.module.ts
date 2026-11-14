import { Module } from '@nestjs/common';
import { PoliciesModule } from '../policies/policies.module';
import { MetersController } from './meters.controller';
import { MetersService } from './meters.service';
import { SimulatorClient } from './simulator.client';

@Module({
  imports: [PoliciesModule],
  controllers: [MetersController],
  providers: [MetersService, SimulatorClient],
  exports: [MetersService, SimulatorClient],
})
export class MetersModule {}
