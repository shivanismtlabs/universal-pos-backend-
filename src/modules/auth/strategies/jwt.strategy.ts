import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/database.module';
import type { AuthUser, JwtPayload } from '../types';

const ACTING_TYPES = new Set(['access', 'pin_access', 'station']);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.typ || !ACTING_TYPES.has(payload.typ)) {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        tenantId: payload.tenantId,
        isActive: true,
        tenant: { status: 'active' },
      },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const locationId = user.primaryLocationId;
    return {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      locationId,
      storeId: locationId,
      roles: user.userRoles.map((ur) => ur.role.code),
      tokenTyp: payload.typ,
    };
  }
}
