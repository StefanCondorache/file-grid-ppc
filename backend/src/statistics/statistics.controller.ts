import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated } from '../auth/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { StatisticsService } from './statistics.service';

const comparisonSchema = z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) });

@Controller('statistics')
@Authenticated('view_statistics')
export class StatisticsController {
  constructor(private readonly statistics: StatisticsService) {}

  @Get('periods')
  async periods() {
    return { data: await this.statistics.periods() };
  }

  @Get('storage-fit')
  storageFit() {
    return this.statistics.storageFit();
  }

  @Get('period-comparison')
  compare(@Query(new ZodPipe(comparisonSchema)) query: z.infer<typeof comparisonSchema>) {
    return this.statistics.compare(query.a, query.b);
  }

  @Get('grid-insights')
  gridInsights() {
    return this.statistics.gridInsights();
  }
}
