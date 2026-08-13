import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { SearchService } from './search.service';

@Module({
  controllers: [AppsController],
  providers: [AppsService, SearchService],
  exports: [AppsService, SearchService],
})
export class AppsModule {}
