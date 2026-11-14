import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB, type Db } from '../database/database';

export interface ReadinessBody {
  status: 'ready' | 'degraded';
  database: 'ok' | 'error';
}

/**
 * Liveness and readiness probes, outside /api. /readyz never fails because a dependency is down
 * (README contract): one dead storage must not pull every backend replica out of the Service, and
 * the circuit breakers already make requests for that storage fail fast. It reports what is down.
 */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(): Promise<ReadinessBody> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'ready', database: 'ok' };
    } catch (error) {
      this.logger.warn({
        message: 'metadata database unreachable',
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'degraded', database: 'error' };
    }
  }
}
