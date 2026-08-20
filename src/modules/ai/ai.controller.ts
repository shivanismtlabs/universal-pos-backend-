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

  @Post('product-image/search-real')
  @Roles(...RoleGroup.catalogWrite)
  @Throttle({
    default: { limit: 12, ttl: 60_000 },
  })
  @ApiOperation({
    summary:
      'Find a real Creative Commons product photo by name (Openverse) — preferred over AI',
  })
  searchRealProductImage(@Body() dto: GenerateProductImageDto) {
    return this.images.searchRealProductImage(dto);
  }

  @Post('product-image/fallback-url')
  @Roles(...RoleGroup.catalogWrite)
  @Throttle({
    default: { limit: 20, ttl: 60_000 },
  })
  @ApiOperation({
    summary:
      'Build a Pollinations image URL for browser-side fallback when server cannot reach AI',
  })
  fallbackUrl(@Body() dto: GenerateProductImageDto) {
    return this.images.buildClientFallbackUrl(dto.name, dto.hint);
  }
}
