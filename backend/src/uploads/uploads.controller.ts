import {
  Body,
  Controller,
  Delete,
  Get,
  Head,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Authenticated, CurrentPrincipal } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { ZodPipe } from '../common/zod.pipe';
import { UploadAssembler } from './upload-assembler';
import {
  type CompleteUpload,
  type CreateUpload,
  completeUploadSchema,
  createUploadSchema,
  idempotencyKeySchema,
} from './upload.schemas';
import { UploadsService } from './uploads.service';

const SHA256_HEX = /^[0-9a-f]{64}$/;

@Controller()
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly assembler: UploadAssembler,
  ) {}

  /** Connectivity probe for the upload client (resume after the network comes back). */
  @Get('ping')
  @HttpCode(204)
  ping(): void {}

  @Head('ping')
  @HttpCode(204)
  pingHead(): void {}

  @Post('uploads')
  @Authenticated()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body(new ZodPipe(createUploadSchema)) body: CreateUpload,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = new ZodPipe(idempotencyKeySchema).transform(rawKey);
    const { created, view } = await this.uploads.create(principal, key, body);
    response.status(created ? 201 : 200);
    return view;
  }

  @Get('uploads/:uploadId')
  @Authenticated()
  status(@CurrentPrincipal() principal: Principal, @Param('uploadId') uploadId: string) {
    return this.uploads.status(principal, uploadId);
  }

  @Delete('uploads/:uploadId')
  @Authenticated()
  @HttpCode(204)
  abort(@CurrentPrincipal() principal: Principal, @Param('uploadId') uploadId: string) {
    return this.uploads.abort(principal, uploadId);
  }

  /** One part as a raw application/octet-stream body, streamed to storage (never buffered whole). */
  @Put('uploads/:uploadId/parts/:partNumber')
  @Authenticated()
  receivePart(
    @CurrentPrincipal() principal: Principal,
    @Param('uploadId') uploadId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() request: Request,
    @Headers('content-length') contentLength: string | undefined,
    @Headers('x-part-sha256') partSha256: string | undefined,
  ) {
    const type = request.headers['content-type'] ?? 'application/octet-stream';
    if (!type.startsWith('application/octet-stream')) {
      throw new AppError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Părțile se trimit ca application/octet-stream.',
      );
    }
    if (partSha256 !== undefined && !SHA256_HEX.test(partSha256)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'X-Part-SHA256 trebuie să fie hex, litere mici.');
    }
    const length = contentLength === undefined ? undefined : Number(contentLength);
    return this.uploads.receivePart(principal, uploadId, partNumber, request, length, partSha256);
  }

  @Post('uploads/:uploadId/complete')
  @Authenticated()
  async complete(
    @CurrentPrincipal() principal: Principal,
    @Param('uploadId') uploadId: string,
    @Body(new ZodPipe(completeUploadSchema)) body: CompleteUpload,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.assembler.complete(principal, uploadId, body);
    if (outcome.kind === 'verifying') {
      response.status(202).set('Retry-After', '2');
      return { status: 'verifying' };
    }
    response.status(200);
    return outcome.result;
  }
}
