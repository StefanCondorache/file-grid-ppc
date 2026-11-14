import { Module } from '@nestjs/common';
import { DownloadService } from './download.service';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController],
  providers: [FilesService, DownloadService],
  exports: [FilesService],
})
export class FilesModule {}
