import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, MeterAuthenticated, MeterKeyId } from '../src/auth/auth.decorators';
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
