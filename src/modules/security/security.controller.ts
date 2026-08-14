import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { clientIpFromRequest } from './client-ip';
import {
  Disable2faDto,
  Enable2faDto,
  ListAuditQueryDto,
  RestoreBackupDto,
  UpdateSecuritySettingsDto,
} from './dto/security.dto';
import { SecurityService } from './security.service';

@ApiTags('security')
@ApiBearerAuth('access-token')
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('settings')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'IP allowlist, session timeout, encryption flags' })
  settings(@CurrentUser() user: AuthUser) {
    return this.security.getSettings(user);
  }

  @Patch('settings')
  @Roles(...RoleGroup.lead)
  @HttpCode(200)
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateSecuritySettingsDto,
  ) {
    return this.security.updateSettings(user, dto);
  }

  @Get('audit-logs')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Tenant audit log (who did what, when, from which IP)' })
  auditLogs(@CurrentUser() user: AuthUser, @Query() query: ListAuditQueryDto) {
    return this.security.listAudit(user, query);
  }

  @Get('activity')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Activity history (same store as audit, human labels)' })
  activity(@CurrentUser() user: AuthUser, @Query() query: ListAuditQueryDto) {
    return this.security.listAudit(user, query);
  }

  @Get('2fa')
  @Roles(...RoleGroup.all)
  my2fa(@CurrentUser() user: AuthUser) {
    return this.security.my2fa(user);
  }

  @Post('2fa/setup')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.security.setup2fa(user);
  }

  @Post('2fa/enable')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  enable2fa(@CurrentUser() user: AuthUser, @Body() dto: Enable2faDto) {
    return this.security.enable2fa(user, dto.code);
  }

  @Post('2fa/disable')
  @Roles(...RoleGroup.all)
  @HttpCode(200)
  disable2fa(@CurrentUser() user: AuthUser, @Body() dto: Disable2faDto) {
    return this.security.disable2fa(user, dto.password);
  }

  @Post('backup/export')
  @Roles(...RoleGroup.ownerOnly)
  @HttpCode(200)
  @ApiOperation({ summary: 'Download shop backup (catalog, customers, stock, settings)' })
  exportBackup(@CurrentUser() user: AuthUser) {
    return this.security.exportBackup(user);
  }

  @Post('backup/restore')
  @Roles(...RoleGroup.ownerOnly)
  @HttpCode(200)
  restoreBackup(@CurrentUser() user: AuthUser, @Body() dto: RestoreBackupDto) {
    return this.security.restoreBackup(user, dto);
  }

  @Get('whoami-ip')
  @Roles(...RoleGroup.all)
  whoamiIp(@Req() req: FastifyRequest, @Headers('user-agent') ua?: string) {
    return { ip: clientIpFromRequest(req), userAgent: ua ?? null };
  }
}
