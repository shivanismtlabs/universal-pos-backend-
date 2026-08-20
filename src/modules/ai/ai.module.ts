import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiImageService } from './ai-image.service';

@Module({
  controllers: [AiController],
  providers: [AiImageService],
  exports: [AiImageService],
})
export class AiModule {}
