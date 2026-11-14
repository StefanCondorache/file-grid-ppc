import { Controller, Get, HttpCode, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal, NoSessionRefresh } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { MetersModule } from '../meters/meters.module';
import { type AlertQuery, AlertsService } from './alerts.service';
import { GuaranteeEvaluator } from './guarantee-evaluator';
import { GuaranteesService } from './guarantees.service';

const alertQuerySchema = z.object({
  state: z.enum(['active', 'resolved', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The "Garanții de business" board and its alerts: every role reads them (PRD FE-07). */
@Controller()
export class GuaranteesController {
  constructor(
    private readonly guarantees: GuaranteesService,
    private readonly alerts: AlertsService,
  ) {}

  @Get('guarantees')
  @Authenticated()
  @NoSessionRefresh()
  async list() {
    return { data: await this.guarantees.all() };
  }

  @Get('alerts')
  @Authenticated()
  @NoSessionRefresh()
  listAlerts(@Query(new ZodPipe(alertQuerySchema)) query: AlertQuery) {
    return this.alerts.list(query);
  }

  @Post('alerts/:alertId/acknowledge')
  @Authenticated()
  @HttpCode(200)
  acknowledge(@CurrentPrincipal() principal: Principal, @Param('alertId') alertId: string) {
    return this.alerts.acknowledge(alertId, principal);
  }
}

@Module({
  imports: [MetersModule],
  controllers: [GuaranteesController],
  providers: [GuaranteesService, AlertsService, GuaranteeEvaluator],
})
export class GuaranteesModule {}
