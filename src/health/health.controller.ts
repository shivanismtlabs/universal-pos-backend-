import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../modules/auth/decorators/auth.decorators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check' })
  check() {
    return {
      status: 'ok',
      service: 'universal-pos-api',
      timestamp: new Date().toISOString(),
    };
  }
}
