import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RoleGroup } from '../../common/roles';
import { Public, Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  AssignShiftDto,
  ClockDto,
  CreateAttendanceDto,
  CreateRoleDto,
  CreateShiftDto,
  ListAttendanceQueryDto,
  ListShiftsQueryDto,
  SetRolePermissionsDto,
  UpdateAttendanceDto,
  UpdateRoleDto,
  UpdateShiftDto,
  WebAuthnAuthDto,
  WebAuthnLabelDto,
} from './dto/iam.dto';
import {
  IamAttendanceService,
  IamShiftsService,
} from './iam-attendance-shifts.service';
import { IamRolesService } from './iam-roles.service';
import { IamWebAuthnService } from './iam-webauthn.service';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

@ApiTags('iam')
@ApiBearerAuth('access-token')
@Controller('iam')
export class IamController {
  constructor(
    private readonly roles: IamRolesService,
    private readonly attendance: IamAttendanceService,
    private readonly shifts: IamShiftsService,
    private readonly webauthn: IamWebAuthnService,
  ) {}

  // ── Roles & permissions ──────────────────────────────────────────
  @Get('permissions')
  @Roles(...RoleGroup.staff)
  @ApiOperation({ summary: 'List permission catalog' })
  listPermissions() {
    return this.roles.listPermissions();
  }

  @Get('roles')
  @Roles(...RoleGroup.staff)
  @ApiOperation({ summary: 'List system + custom roles with permissions' })
  listRoles(@CurrentUser() user: AuthUser) {
    return this.roles.listRoles(user);
  }

  @Post('roles')
  @Roles(...RoleGroup.staff)
  @ApiOperation({ summary: 'Create custom role' })
  createRole(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto) {
    return this.roles.createRole(user, dto);
  }

  @Patch('roles/:id')
  @Roles(...RoleGroup.staff)
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roles.updateRole(user, id, dto);
  }

  @Post('roles/:id/permissions')
  @Roles(...RoleGroup.staff)
  setPerms(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
  ) {
    return this.roles.setPermissions(user, id, dto);
  }

  @Delete('roles/:id')
  @Roles(...RoleGroup.staff)
  deleteRole(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.roles.deleteRole(user, id);
  }

  // ── Attendance ───────────────────────────────────────────────────
  @Post('attendance/clock-in')
  @Roles(...RoleGroup.all)
  clockIn(@CurrentUser() user: AuthUser, @Body() dto: ClockDto) {
    return this.attendance.clockIn(user, dto);
  }

  @Post('attendance/clock-out')
  @Roles(...RoleGroup.all)
  clockOut(@CurrentUser() user: AuthUser, @Body() dto: ClockDto) {
    return this.attendance.clockOut(user, dto);
  }

  @Get('attendance/open')
  @Roles(...RoleGroup.all)
  openAttendance(@CurrentUser() user: AuthUser) {
    return this.attendance.myOpen(user);
  }

  @Get('attendance')
  @Roles(...RoleGroup.all)
  listAttendance(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAttendanceQueryDto,
  ) {
    return this.attendance.list(user, query);
  }

  @Post('attendance')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Create manual attendance entry' })
  createAttendance(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAttendanceDto,
  ) {
    return this.attendance.createManual(user, dto);
  }

  @Get('attendance/:id')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'View attendance entry' })
  getAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attendance.getOne(user, id);
  }

  @Patch('attendance/:id')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update attendance entry' })
  updateAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttendanceDto,
  ) {
    return this.attendance.update(user, id, dto);
  }

  @Delete('attendance/:id')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Delete attendance entry' })
  deleteAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attendance.remove(user, id);
  }

  // ── Shifts ───────────────────────────────────────────────────────
  @Get('shifts')
  @Roles(...RoleGroup.all)
  listShifts(@CurrentUser() user: AuthUser) {
    return this.shifts.listTemplates(user);
  }

  @Post('shifts')
  @Roles(...RoleGroup.staff)
  createShift(@CurrentUser() user: AuthUser, @Body() dto: CreateShiftDto) {
    return this.shifts.createTemplate(user, dto);
  }

  @Patch('shifts/:id')
  @Roles(...RoleGroup.staff)
  updateShift(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShiftDto,
  ) {
    return this.shifts.updateTemplate(user, id, dto);
  }

  @Delete('shifts/:id')
  @Roles(...RoleGroup.staff)
  deleteShift(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shifts.deleteTemplate(user, id);
  }

  @Get('shift-assignments')
  @Roles(...RoleGroup.all)
  listAssignments(
    @CurrentUser() user: AuthUser,
    @Query() query: ListShiftsQueryDto,
  ) {
    return this.shifts.listAssignments(user, query);
  }

  @Post('shift-assignments')
  @Roles(...RoleGroup.staff)
  assignShift(@CurrentUser() user: AuthUser, @Body() dto: AssignShiftDto) {
    return this.shifts.assign(user, dto);
  }

  @Delete('shift-assignments/:id')
  @Roles(...RoleGroup.staff)
  removeAssignment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shifts.removeAssignment(user, id);
  }

  // ── Biometric (WebAuthn, optional) ───────────────────────────────
  @Post('webauthn/register/options')
  @Roles(...RoleGroup.all)
  regOptions(
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin?: string,
    @Body() dto?: WebAuthnLabelDto,
  ) {
    return this.webauthn.registrationOptions(
      user,
      dto?.clientOrigin || origin,
    );
  }

  @Post('webauthn/register/verify')
  @Roles(...RoleGroup.all)
  regVerify(
    @CurrentUser() user: AuthUser,
    @Body() dto: WebAuthnLabelDto,
    @Headers('origin') origin?: string,
  ) {
    return this.webauthn.registrationVerify(
      user,
      dto.response as unknown as RegistrationResponseJSON,
      dto.label,
      dto.clientOrigin || origin,
    );
  }

  @Get('webauthn/credentials')
  @Roles(...RoleGroup.all)
  listCreds(@CurrentUser() user: AuthUser) {
    return this.webauthn.listCredentials(user);
  }

  @Delete('webauthn/credentials/:id')
  @Roles(...RoleGroup.all)
  delCred(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webauthn.deleteCredential(user, id);
  }

  @Public()
  @Post('webauthn/login/options')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  loginOptions(
    @Body() dto: WebAuthnAuthDto,
    @Headers('origin') origin?: string,
  ) {
    return this.webauthn.authenticationOptions(
      dto.email,
      dto.clientOrigin || origin,
    );
  }

  @Public()
  @Post('webauthn/login/verify')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  loginVerify(
    @Body() dto: WebAuthnAuthDto,
    @Headers('origin') origin?: string,
  ) {
    return this.webauthn.authenticationVerify(
      dto.email,
      dto.response as unknown as AuthenticationResponseJSON,
      dto.clientOrigin || origin,
    );
  }
}
