import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ListNotifyLogsQueryDto, SendNotificationDto } from './dto/notify.dto';
import { NotifyService } from './notify.service';

@ApiTags('notify')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.notify)
@Controller('notify')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @Get('config')
  @ApiOperation({ summary: 'WhatsApp / Gupshup provider status' })
  config() {
    return this.notifyService.getConfig();
  }

  @Post('send')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send WhatsApp notification via Gupshup (or mock if keys missing)',
  })
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    return this.notifyService.send(user, dto);
  }

  @Get('logs')
  @ApiOperation({ summary: 'List notification logs' })
  listLogs(
    @CurrentUser() user: AuthUser,
    @Query() query: ListNotifyLogsQueryDto,
  ) {
    return this.notifyService.listLogs(user, query);
  }
}
