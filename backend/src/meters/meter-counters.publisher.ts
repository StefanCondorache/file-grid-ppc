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
import { MetersService } from './meters.service';

/**
 * Publishes `meters.counters` every STREAM_COUNTERS_INTERVAL_S from the leader replica only, so the
 * counter queries run once for the whole cluster; NOTIFY carries the snapshot to every replica.
 */
@Injectable()
export class MeterCountersPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeterCountersPublisher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cluster: ClusterChannel,
    private readonly events: EventBus,
    private readonly meters: MetersService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.stream.countersIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.cluster.isLeader())) return;
      const counters = await this.meters.liveCounters();
      this.events.publish('meters.counters', counters, { capability: 'view_meters' });
    } catch (error) {
      this.logger.warn({
        message: 'could not publish the meter counters',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
