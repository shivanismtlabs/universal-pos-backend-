import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RoleGroup } from '../../common/roles';
import { Public, Roles } from './decorators/auth.decorators';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import {
  GoogleAuthDto,
  LoginDto,
  PinLoginDto,
  RefreshTokenDto,
  RegisterTenantDto,
  RegisterUserDto,
  SetPinDto,
  SignupIdentityDto,
  CreateOrganizationDto,
  SelectOrganizationDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ForgotPinDto,
  ResetPinOtpDto,
} from './dto/auth.dto';
import { RolesGuard } from './guards/roles.guard';
import type { AuthUser } from './types';
import { PortalAuthService } from './portal-auth.service';
import { AuthRecoveryService } from './auth-recovery.service';
import { clientIpFromRequest } from '../security/client-ip';
import { Login2faDto } from '../security/dto/security.dto';
import type { FastifyRequest } from 'fastify';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly portal: PortalAuthService,
    private readonly recovery: AuthRecoveryService,
  ) {}

  @Public()
  @Post('signup')
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 5 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Zoho-style: create personal account (then setup organization)',
  })
  signup(@Body() dto: SignupIdentityDto) {
    return this.portal.signupIdentity(dto);
  }

  @Public()
  @Get('organizations')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'List organizations for identity token' })
  organizations(@Headers('authorization') authorization?: string) {
    return this.portal
      .requireIdentityFromAuthHeader(authorization)
      .then((id) => this.portal.listOrganizations(id.id));
  }

  @Public()
  @Post('organizations')
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 5 : 30,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Create organization / shop under identity' })
  createOrganization(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.portal
      .requireIdentityFromAuthHeader(authorization)
      .then((id) => this.portal.createOrganization(id.id, dto));
  }

  @Public()
  @Post('select-organization')
  @HttpCode(200)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @ApiOperation({ summary: 'Enter a shop (issues tenant session tokens)' })
  selectOrganization(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SelectOrganizationDto,
    @Req() req: FastifyRequest,
  ) {
    return this.portal
      .requireIdentityFromAuthHeader(authorization)
      .then((id) =>
        this.portal.selectOrganization(
          id.id,
          dto.tenantId,
          clientIpFromRequest(req),
        ),
      );
  }

  @Public()
  @Post('register-tenant')
  @Throttle({
    default: {
      // Dev: many retries while testing; prod stays strict but QA-usable
      // (2/min was too aggressive behind shared NAT / demo IP)
      limit: process.env.NODE_ENV === 'production' ? 6 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Register a new tenant (shop) + admin user' })
  registerTenant(@Body() dto: RegisterTenantDto) {
    return this.authService.registerTenant(dto);
  }

  @Public()
  @Post('register-user')
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 5 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Register a user under an existing shop (default staff role)',
  })
  registerUser(@Body() dto: RegisterUserDto) {
    return this.authService.registerUser(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({
    default: {
      // Shared shop IP: cashiers must login often; 5/min was too strict in prod
      limit: process.env.NODE_ENV === 'production' ? 30 : 60,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Login with tenant slug + email + password' })
  login(@Body() dto: LoginDto, @Req() req: FastifyRequest) {
    return this.authService.login(dto, { ip: clientIpFromRequest(req) });
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 10 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Complete login with TOTP / backup code' })
  login2fa(@Body() dto: Login2faDto, @Req() req: FastifyRequest) {
    return this.authService.loginWith2fa(
      dto.totpToken,
      dto.code,
      clientIpFromRequest(req),
    );
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 5 : 30,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Send 6-digit OTP to reset password' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.recovery.requestPasswordOtp(dto.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 8 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Reset password with email OTP' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.recovery.resetPassword({
      email: dto.email,
      otp: dto.otp,
      newPassword: dto.newPassword,
    });
  }

  @Public()
  @Post('pin/forgot')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 8 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Send OTP to staff email to reset counter PIN' })
  forgotPin(@Body() dto: ForgotPinDto) {
    return this.recovery.requestPinOtp(dto.userId);
  }

  @Public()
  @Post('pin/reset-otp')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 8 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Set new PIN using email OTP' })
  resetPinOtp(@Body() dto: ResetPinOtpDto) {
    return this.recovery.resetPin({
      userId: dto.userId,
      otp: dto.otp,
      newPin: dto.newPin,
    });
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 8 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Sign in / register shop with Google ID token' })
  google(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuth(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate refresh token + new access token' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  logout(@CurrentUser() user: AuthUser) {
    return this.authService.logout(user);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Current authenticated user' })
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user);
  }

  @Post('pin/set')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Set or change your own counter PIN' })
  setOwnPin(@CurrentUser() user: AuthUser, @Body() dto: SetPinDto) {
    return this.authService.setOwnPin(user, dto);
  }

  @Post('pin/set/:userId')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @UseGuards(RolesGuard)
  @Roles(...RoleGroup.staff)
  @ApiOperation({ summary: 'Admin/manager sets another staff member PIN' })
  setUserPin(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetPinDto,
  ) {
    return this.authService.setUserPin(user, userId, dto);
  }

  @Get('pin/staff')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List staff at a location for PIN switch (pinSet flags only)',
  })
  listPinStaff(
    @CurrentUser() user: AuthUser,
    @Query('locationId', ParseUUIDPipe) locationId: string,
  ) {
    return this.authService.listPinStaff(user, locationId);
  }

  @Post('pin/login')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'production' ? 30 : 80,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary:
      'Staff-switch via PIN on an unlocked station (requires station JWT)',
  })
  pinLogin(@CurrentUser() user: AuthUser, @Body() dto: PinLoginDto) {
    return this.authService.pinLogin(user, dto);
  }
}
