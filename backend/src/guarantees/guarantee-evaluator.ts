import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ClusterChannel } from '../events/cluster-channel.service';
import { EventBus } from '../events/event-bus.service';
import { METER_READINGS_LOST } from '../observability/app-metrics';
import { AlertsService } from './alerts.service';
import { type GuaranteeStatus, GuaranteesService } from './guarantees.service';

/** The `lost` metric of the meter-readings guarantee; NaN when the loss is unknown. */
function meterReadingsLost(statuses: readonly GuaranteeStatus[]): number {
  const value = statuses
    .find((status) => status.category === 'meter_readings')
    ?.metrics.find((metric) => metric.key === 'lost')?.value;
  return value === null || value === undefined ? Number.NaN : Number(value);
}

/**
 * Every GUARANTEE_EVAL_INTERVAL_S (15 s), on the leader replica only (Postgres advisory lock):
 * computes the guarantees, records alert transitions, publishes `guarantees.status` and sets the
 * gauge filegrid_meter_readings_lost. The other replicas expose that gauge as 0, so a former
 * leader does not keep reporting a stale loss.
 */
@Injectable()
export class GuaranteeEvaluator implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GuaranteeEvaluator.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cluster: ClusterChannel,
    private readonly guarantees: GuaranteesService,
    private readonly alerts: AlertsService,
    private readonly events: EventBus,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.guarantees.evalIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One evaluation (the leader check is the caller's). */
  async evaluateOnce(): Promise<void> {
    let statuses: GuaranteeStatus[];
    try {
      statuses = await this.guarantees.all();
    } catch (error) {
      METER_READINGS_LOST.set(Number.NaN); // no evaluation: the loss is unknown, not 0
      throw error;
    }
    METER_READINGS_LOST.set(meterReadingsLost(statuses));
    await this.alerts.record(statuses);
    this.events.publish('guarantees.status', { items: statuses });
  }

  /** One timer tick (public for the tests). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.cluster.isLeader()) await this.evaluateOnce();
      else METER_READINGS_LOST.set(0);
    } catch (error) {
      this.logger.warn({
        message: 'guarantee evaluation failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
