import { Body, Controller, Get, Inject, Module, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { Authenticated, MeterAuthenticated, MeterKeyId } from '../src/auth/auth.decorators';
import { ZodPipe } from '../src/common/zod.pipe';
import { DB, type Db } from '../src/database/database';

const credentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
  attempts: z.number().int(),
});

/** Routes that exist only in tests, to exercise the error filter and the guards. */
@Controller('test-only')
class TestOnlyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Waits `ms`, then queries the database: a request still running when shutdown starts. */
  @Get('slow')
  async slow(@Query('ms') ms = '100'): Promise<{ ok: true; database: number | undefined }> {
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
    const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(this.db);
    return { ok: true, database: result.rows[0]?.one };
  }

  /** Never answers (a stuck download, say): shutdown must not wait for it forever. */
  @Get('hang')
  hang(@Res() _response: Response): void {
    // deliberately left open
  }

  @Get('boom')
  boom(): never {
    throw new Error('database password is hunter2');
  }

  @Post('validate')
  validate(@Body(new ZodPipe(credentialsSchema)) body: z.infer<typeof credentialsSchema>): {
    ok: string;
  } {
    return { ok: body.username };
  }

  @Get('policies-admin')
  @Authenticated('edit_policies')
  adminOnly(): { ok: string } {
    return { ok: 'yes' };
  }

  @Get('meter')
  @MeterAuthenticated()
  meter(@MeterKeyId() keyId: string): { keyId: string } {
    return { keyId };
  }
}

@Module({ controllers: [TestOnlyController] })
export class TestOnlyModule {}
