import { Module } from '@nestjs/common';
import { PoliciesModule } from '../policies/policies.module';
import { UploadAssembler } from './upload-assembler';
import { UploadSweeper } from './upload-sweeper';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [PoliciesModule],
  controllers: [UploadsController],
  providers: [UploadsService, UploadAssembler, UploadSweeper],
  exports: [UploadsService],
})
export class UploadsModule {}
