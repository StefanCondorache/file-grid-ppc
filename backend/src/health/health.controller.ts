import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import { DB, type Db } from '../database/database';
import { Lifecycle } from '../lifecycle/lifecycle';

export interface ReadinessBody {
  status: 'ready' | 'degraded' | 'starting' | 'stopping';
  database: 'ok' | 'error';
}

/**
 * Liveness and readiness probes, outside /api. Once the app is running, /readyz never fails
 * because a dependency is down (README contract): one dead storage, or the database after the
 * boot, must not pull every backend replica out of the Service (the circuit breakers make those
 * requests fail fast); it reports `degraded`. It answers 503 only while the process is
 * `starting` (database not reached and migrated yet) or `stopping` (SIGTERM, draining).
 */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly lifecycle: Lifecycle,
  ) {}

  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) response: Response): Promise<ReadinessBody> {
    const database = await this.database();
    const state = this.lifecycle.state;
    if (state !== 'running') {
      response.status(503).setHeader('Retry-After', '5');
      return { status: state, database };
    }
    return { status: database === 'ok' ? 'ready' : 'degraded', database };
  }

  private async database(): Promise<ReadinessBody['database']> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return 'ok';
    } catch (error) {
      if (this.lifecycle.state === 'running') {
        this.logger.warn({
          message: 'metadata database unreachable',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 'error';
    }
  }
}
