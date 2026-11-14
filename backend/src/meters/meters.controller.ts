import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import {
  Authenticated,
  CurrentPrincipal,
  DemoOnly,
  MeterAuthenticated,
  MeterKeyId,
  NoSessionRefresh,
} from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { Inject } from '@nestjs/common';
import { DB, type Db } from '../database/database';
import { EventBus } from '../events/event-bus.service';
import {
  type ReadingBatch,
  type ReadingQuery,
  batchSchema,
  readingQuerySchema,
} from './meters.schemas';
import { MetersService } from './meters.service';
import { SimulatorClient, type SimulatorUpdate } from './simulator.client';

const simulatorUpdateSchema = z
  .object({
    mode: z.enum(['normal', 'peak', 'custom', 'stopped']),
    ratePerS: z.number().min(0).max(1000).nullable().optional(),
    durationS: z.number().int().min(1).max(3600).optional(),
  })
  .refine((u) => u.mode !== 'custom' || typeof u.ratePerS === 'number', {
    path: ['ratePerS'],
    message: 'ratePerS este obligatoriu pentru modul custom',
  });

@Controller()
export class MetersController {
  constructor(
    private readonly meters: MetersService,
    private readonly simulator: SimulatorClient,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  /** Smart meters (the simulator) send batches here with X-API-Key. */
  @Post('meter-readings')
  @MeterAuthenticated()
  @HttpCode(200)
  ingest(@Body(new ZodPipe(batchSchema)) batch: ReadingBatch, @MeterKeyId() keyId: string) {
    return this.meters.ingest(batch, keyId);
  }

  @Get('meter-readings')
  @Authenticated('view_meters')
  list(@Query(new ZodPipe(readingQuerySchema)) query: ReadingQuery) {
    return this.meters.list(query);
  }

  @Get('meters/counters')
  @Authenticated('view_meters')
  @NoSessionRefresh()
  counters() {
    return this.meters.liveCounters();
  }

  @Get('meters/simulator')
  @Authenticated('view_meters')
  simulatorStatus() {
    return this.simulator.status();
  }

  @Put('meters/simulator')
  @DemoOnly()
  async setSimulator(
    @Body(new ZodPipe(simulatorUpdateSchema)) body: SimulatorUpdate,
    @CurrentPrincipal() principal: Principal,
  ) {
    const status = await this.simulator.update(body);
    this.events.publish('simulator.status', { ...status }, { capability: 'view_meters' });
    await this.audit.record(this.db, {
      actor: principal.username,
      action: 'simulator_rate',
      outcome: 'success',
      demo: true,
      category: 'meter_readings',
      details: `${body.mode}${body.ratePerS ? ` ${body.ratePerS}/s` : ''}`,
    });
    return status;
  }
}
