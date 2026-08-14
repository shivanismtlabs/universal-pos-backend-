import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  ListInboxQueryDto,
  RegisterPushTokenDto,
  UnregisterPushTokenDto,
  UpdateTenantNotificationSettingsDto,
  UpdateUserNotificationPrefsDto,
} from './dto/notification-inbox.dto';
import { NotifyService } from './notify.service';
import { NotificationEngineService } from './notification-engine.service';
import { FirebasePushService } from './firebase-push.service';

@ApiTags('notify')
@ApiBearerAuth('access-token')
@Controller('notify')
export class NotifyController {
  constructor(
    private readonly notifyService: NotifyService,
    private readonly engine: NotificationEngineService,
    private readonly firebase: FirebasePushService,
  ) {}

  @Get('config')
  @Roles(...RoleGroup.notify)
  @ApiOperation({ summary: 'WhatsApp / email / SMS provider status' })
  config() {
    return this.notifyService.getConfig();
  }

  @Get('inbox')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'In-app notification center for current user' })
  inbox(@CurrentUser() user: AuthUser, @Query() query: ListInboxQueryDto) {
    return this.engine.listForUser(user, query);
  }

  @Get('inbox/unread-count')
  @Roles(...RoleGroup.all)
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.engine.listForUser(user, { limit: 1 }).then((r) => ({
      unreadCount: r.unreadCount,
    }));
  }

  /** Static path must be registered before inbox/:id/... */
  @Post('inbox/mark-all-read')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all inbox notifications as read' })
  markAllReadPost(@CurrentUser() user: AuthUser) {
    return this.engine.markAllRead(user);
  }

  @Patch('inbox/mark-all-read')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  markAllReadPatch(@CurrentUser() user: AuthUser) {
    return this.engine.markAllRead(user);
  }

  /** Alias kept for older clients */
  @Post('inbox/read-all')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  markAllReadAlias(@CurrentUser() user: AuthUser) {
    return this.engine.markAllRead(user);
  }

  @Patch('inbox/:id/read')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  markRead(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.engine.markRead(user, id);
  }

  @Get('settings/types')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Tenant notification type enable/disable config' })
  tenantSettings(@CurrentUser() user: AuthUser) {
    return this.engine.getTenantSettings(user.tenantId);
  }

  @Patch('settings/types')
  @Roles(...RoleGroup.lead)
  @HttpCode(200)
  updateTenantSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTenantNotificationSettingsDto,
  ) {
    return this.engine.updateTenantSettings(user.tenantId, dto.types);
  }

  @Get('settings/preferences')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'My per-type channel preferences' })
  myPrefs(@CurrentUser() user: AuthUser) {
    return this.engine.getUserPrefs(user);
  }

  @Patch('settings/preferences')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  updateMyPrefs(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateUserNotificationPrefsDto,
  ) {
    return this.engine.upsertUserPrefs(user, dto.prefs);
  }

  @Get('push/status')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Whether Firebase FCM is configured on the API' })
  pushStatus() {
    return { firebaseConfigured: this.firebase.isConfigured() };
  }

  @Post('push/register')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  @ApiOperation({ summary: 'Register FCM device token for this user' })
  registerPush(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterPushTokenDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.firebase.registerToken({
      tenantId: user.tenantId,
      userId: user.userId,
      token: dto.token,
      platform: dto.platform ?? 'web',
      userAgent,
    });
  }

  @Post('push/unregister')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate FCM device token' })
  unregisterPush(
    @CurrentUser() user: AuthUser,
    @Body() dto: UnregisterPushTokenDto,
  ) {
    return this.firebase.unregisterToken({
      tenantId: user.tenantId,
      userId: user.userId,
      token: dto.token,
    });
  }

  @Post('send')
  @Roles(...RoleGroup.notify)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send WhatsApp / SMS / email notification',
  })
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    return this.notifyService.send(user, dto);
  }

  @Post('invoice')
  @Roles(...RoleGroup.notify)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Email / SMS / WhatsApp invoice for an order',
  })
  sendInvoice(@CurrentUser() user: AuthUser, @Body() dto: SendInvoiceDto) {
    return this.notifyService.sendOrderInvoice(user, dto);
  }

  @Get('birthdays/upcoming')
  @Roles(...RoleGroup.notify)
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
  @Roles(...RoleGroup.notify)
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
  @Roles(...RoleGroup.lead)
  logs(@CurrentUser() user: AuthUser, @Query() query: ListNotifyLogsQueryDto) {
    return this.notifyService.listLogs(user, query);
  }
}
