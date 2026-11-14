import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import { DB, type Db } from '../database/database';

export interface ReadinessBody {
  status: 'ready' | 'unavailable';
  database: 'ok' | 'error';
}

/** Liveness and readiness probes, outside /api for Kubernetes and compose. */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) response: Response): Promise<ReadinessBody> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'ready', database: 'ok' };
    } catch (error) {
      this.logger.warn({
        message: 'readiness check failed',
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503);
      return { status: 'unavailable', database: 'error' };
    }
  }
}
