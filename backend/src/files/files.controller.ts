import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, CurrentPrincipal } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { DownloadService } from './download.service';
import { type FileQuery, fileQuerySchema, revealSchema } from './file.schemas';
import { FilesService, fileDetail } from './files.service';

@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly downloads: DownloadService,
  ) {}

  @Get()
  @Authenticated()
  search(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodPipe(fileQuerySchema)) query: FileQuery,
  ) {
    return this.files.search(principal, query);
  }

  @Get(':fileId')
  @Authenticated()
  async detail(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string) {
    return fileDetail(await this.files.visible(principal, fileId));
  }

  @Get(':fileId/content')
  @Authenticated()
  async content(
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Headers('range') range: string | undefined,
    @Headers('if-range') ifRange: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.downloads.send(principal, fileId, response, { range, ifRange });
  }

  @Post(':fileId/verification')
  @Authenticated()
  @HttpCode(200)
  verify(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string) {
    return this.files.verify(principal, fileId);
  }

  @Get(':fileId/custody')
  @Authenticated()
  custody(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string) {
    return this.files.custody(principal, fileId);
  }

  @Post(':fileId/reveal')
  @Authenticated('reveal_pii')
  @HttpCode(200)
  reveal(
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body(new ZodPipe(revealSchema)) body: { reason: string },
  ) {
    return this.files.reveal(principal, fileId, body.reason);
  }
}
