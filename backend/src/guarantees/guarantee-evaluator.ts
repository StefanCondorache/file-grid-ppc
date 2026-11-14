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
import { AlertsService } from './alerts.service';
import { GuaranteesService } from './guarantees.service';

/**
 * Every GUARANTEE_EVAL_INTERVAL_S (15 s), on the leader replica only (Postgres advisory lock):
 * computes the guarantees, records alert transitions and publishes `guarantees.status`.
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
    const statuses = await this.guarantees.all();
    await this.alerts.record(statuses);
    this.events.publish('guarantees.status', { items: statuses });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.cluster.isLeader()) await this.evaluateOnce();
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
