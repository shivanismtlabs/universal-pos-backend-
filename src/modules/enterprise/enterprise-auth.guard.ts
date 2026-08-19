import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { expandPermissions } from '../../common/rbac';
import { ensureBusinessGroupForIdentity } from '../../common/ensure-business-group';
import { parseEntitlements } from '../../common/entitlements';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { EnterprisePrincipal, GroupRole } from './enterprise.types';

@Injectable()
export class EnterpriseAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthUser;
      enterprise?: EnterprisePrincipal;
    }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing token');
    }
    const token = header.slice(7).trim();
    let payload: {
      sub?: string;
      tenantId?: string;
      typ?: string;
      email?: string;
      sid?: string;
    };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    let identityId: string | null = null;
    let shopUser: AuthUser | null = null;

    if (payload.typ === 'identity' && payload.sub) {
      identityId = payload.sub;
    } else if (
      payload.typ &&
      ['access', 'pin_access', 'station'].includes(payload.typ) &&
      payload.sub &&
      payload.tenantId
    ) {
      const user = await this.prisma.user.findFirst({
        where: {
          id: payload.sub,
          tenantId: payload.tenantId,
          isActive: true,
        },
        include: { userRoles: { include: { role: true } } },
      });
      if (!user) throw new UnauthorizedException('User not found');
      const roles = user.userRoles.map((ur) => ur.role.code);
      const roleIds = user.userRoles.map((ur) => ur.roleId);
      const permRows =
        roleIds.length > 0
          ? await this.prisma.rolePermission.findMany({
              where: { roleId: { in: roleIds } },
              select: { permission: { select: { code: true } } },
            })
          : [];
      shopUser = {
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        fullName: user.fullName,
        locationId: user.primaryLocationId,
        storeId: user.primaryLocationId,
        roles,
        permissions: expandPermissions(
          roles,
          permRows.map((r) => r.permission.code),
        ),
        tokenTyp: payload.typ as AuthUser['tokenTyp'],
        sessionId: payload.sid,
      };
      req.user = shopUser;
      const link = await this.prisma.identityTenantMembership.findFirst({
        where: { userId: user.id },
        select: { identityId: true },
      });
      identityId = link?.identityId ?? null;
    } else {
      throw new UnauthorizedException('Unsupported token type');
    }

    if (!identityId) {
      throw new UnauthorizedException(
        'This account is not linked to an identity. Sign in via the portal.',
      );
    }

    const identity = await this.prisma.identityAccount.findUnique({
      where: { id: identityId },
      select: { id: true, email: true, fullName: true },
    });
    if (!identity) throw new UnauthorizedException('Identity not found');

    const wrapped = await ensureBusinessGroupForIdentity(this.prisma, identity.id);
    if (!wrapped) {
      throw new UnauthorizedException('No businesses on this account');
    }

    const membership = await this.prisma.businessGroupMembership.findUnique({
      where: {
        groupId_identityId: {
          groupId: wrapped.id,
          identityId: identity.id,
        },
      },
    });
    const groupRole = (membership?.role ?? 'member') as GroupRole;

    const tenantRows = await this.prisma.identityTenantMembership.findMany({
      where: {
        identityId: identity.id,
        tenant: { status: 'active', businessGroupId: wrapped.id },
      },
      select: { tenantId: true },
    });

    req.enterprise = {
      identityId: identity.id,
      email: identity.email,
      fullName: identity.fullName,
      groupId: wrapped.id,
      groupRole,
      entitlements: [...parseEntitlements(wrapped.entitlements)],
      tenantIds: tenantRows.map((t) => t.tenantId),
      shopUser,
    };
    return true;
  }
}
