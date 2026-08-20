import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { AiImageService } from './ai-image.service';
import { GenerateProductImageDto } from './dto/ai-image.dto';

@ApiTags('ai')
@ApiBearerAuth('access-token')
@Controller('ai')
export class AiController {
  constructor(private readonly images: AiImageService) {}

  @Post('product-image')
  @Roles(...RoleGroup.catalogWrite)
  @Throttle({
    default: { limit: 8, ttl: 60_000 },
  })
  @ApiOperation({
    summary:
      'Generate a catalog product image from the product name (Pollinations.ai)',
  })
  generateProductImage(@Body() dto: GenerateProductImageDto) {
    return this.images.generateProductImage(dto);
  }
}
