import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { UploadsService } from './uploads.service';

/** Runs UploadsService.sweepExpired every UPLOAD_SWEEP_INTERVAL_S (default 5 min) on each replica. */
@Injectable()
export class UploadSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UploadSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uploads: UploadsService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.uploadSweepIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const dropped = await this.uploads.sweepExpired();
      if (dropped > 0) {
        this.logger.log({
          message: 'dropped the staged parts of abandoned uploads',
          parts: dropped,
        });
      }
    } catch (error) {
      this.logger.warn({
        message: 'sweep of abandoned uploads failed (retried at the next interval)',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
