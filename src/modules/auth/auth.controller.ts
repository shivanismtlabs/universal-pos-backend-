import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
} from './dto/auth.dto';
import { RolesGuard } from './guards/roles.guard';
import type { AuthUser } from './types';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register-tenant')
  @Throttle({
    default: {
      // Dev: many retries while testing; prod stays strict
      limit: process.env.NODE_ENV === 'production' ? 2 : 30,
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
      limit: process.env.NODE_ENV === 'production' ? 5 : 40,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Login with tenant slug + email + password' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
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
