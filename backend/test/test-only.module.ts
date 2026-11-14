import { Body, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, MeterKeyId } from '../src/auth/auth.decorators';
import { MeterKeyGuard } from '../src/auth/auth.guards';
import { AuthModule } from '../src/auth/auth.module';
import { ZodPipe } from '../src/common/zod.pipe';

const credentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
  attempts: z.number().int(),
});

/** Routes that exist only in tests, to exercise the error filter and the guards. */
@Controller('test-only')
class TestOnlyController {
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

  @Get('admin')
  @AdminOnly()
  adminOnly(): { ok: string } {
    return { ok: 'yes' };
  }

  @Get('meter')
  @UseGuards(MeterKeyGuard)
  meter(@MeterKeyId() keyId: string): { key_id: string } {
    return { key_id: keyId };
  }
}

@Module({ imports: [AuthModule], controllers: [TestOnlyController] })
export class TestOnlyModule {}
