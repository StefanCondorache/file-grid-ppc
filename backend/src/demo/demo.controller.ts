import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, DemoOnly } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { STORAGES, type StorageName } from '../common/domain';
import { ZodPipe } from '../common/zod.pipe';
import { DemoService } from './demo.service';

const stormSchema = z.object({
  category: z.literal('meter_readings').default('meter_readings'),
  durationS: z.number().int().min(10).max(3600).default(300),
});
const corruptionSchema = z.object({ fileId: z.string().uuid() });
const storageParam = new ZodPipe(z.enum(STORAGES));
const actionParam = new ZodPipe(z.enum(['stop', 'start']));

@Controller('demo')
@DemoOnly()
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('status')
  status() {
    return this.demo.status();
  }

  @Post('storms')
  @HttpCode(201)
  storm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(stormSchema)) body: z.infer<typeof stormSchema>,
  ) {
    return this.demo.startStorm(principal, body.durationS);
  }

  @Delete('storms/:category')
  stopStorm(@CurrentPrincipal() principal: Principal) {
    return this.demo.stopStorm(principal);
  }

  @Post('corruptions')
  @HttpCode(201)
  corrupt(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(corruptionSchema)) body: z.infer<typeof corruptionSchema>,
  ) {
    return this.demo.corrupt(principal, body.fileId);
  }

  @Post('storages/:storage/:action')
  @HttpCode(200)
  storage(
    @CurrentPrincipal() principal: Principal,
    @Param('storage', storageParam) storage: StorageName,
    @Param('action', actionParam) action: 'stop' | 'start',
  ) {
    return this.demo.setStorage(principal, storage, action === 'start');
  }
}
