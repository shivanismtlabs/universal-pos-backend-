import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

/** Super-admin console APIs — FR-PADM */
@Module({
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
