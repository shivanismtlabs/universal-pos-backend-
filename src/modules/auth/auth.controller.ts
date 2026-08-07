import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from './decorators/auth.decorators';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RefreshTokenDto,
  RegisterTenantDto,
  RegisterUserDto,
} from './dto/auth.dto';
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
}
