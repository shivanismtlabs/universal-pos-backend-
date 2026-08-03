import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { PlatformService } from './platform.service';

@ApiTags('platform')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.ownerOnly)
@Controller('platform')
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Get('health-usage')
  @ApiOperation({
    summary:
      'Platform-wide health/usage counters (tenants, orders today, payments today)',
  })
  healthUsage() {
    return this.platformService.healthUsage();
  }
}
