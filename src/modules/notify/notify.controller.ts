import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  BirthdaySendDto,
  ListNotifyLogsQueryDto,
  SendInvoiceDto,
  SendNotificationDto,
} from './dto/notify.dto';
import { NotifyService } from './notify.service';

@ApiTags('notify')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.notify)
@Controller('notify')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @Get('config')
  @ApiOperation({ summary: 'WhatsApp / email / SMS provider status' })
  config() {
    return this.notifyService.getConfig();
  }

  @Post('send')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send WhatsApp / SMS / email notification',
  })
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    return this.notifyService.send(user, dto);
  }

  @Post('invoice')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Email / SMS / WhatsApp invoice for an order',
  })
  sendInvoice(@CurrentUser() user: AuthUser, @Body() dto: SendInvoiceDto) {
    return this.notifyService.sendOrderInvoice(user, dto);
  }

  @Get('birthdays/upcoming')
  @ApiOperation({
    summary: 'Customers with birthdays in the next N days (optional reminders)',
  })
  birthdaysUpcoming(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
  ) {
    return this.notifyService.listBirthdayUpcoming(
      user,
      days ? Number(days) : 30,
    );
  }

  @Post('birthdays/send-today')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Send birthday wishes to marketingOptIn customers whose birthday is today',
  })
  birthdaysSendToday(
    @CurrentUser() user: AuthUser,
    @Body() dto: BirthdaySendDto,
  ) {
    return this.notifyService.sendBirthdayToday(
      user,
      dto.channels ?? ['sms', 'whatsapp'],
    );
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
