import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ROLE_PERMISSION_FALLBACK,
  hasPermission,
} from '../../../common/rbac';
import {
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '../decorators/auth.decorators';
import type { AuthUser } from '../types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles?.length && !requiredPerms?.length) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user: AuthUser }>();
    if (!user) {
      throw new ForbiddenException('Insufficient role');
    }

    if (user.roles?.includes('admin') || hasPermission(user.permissions, '*')) {
      return true;
    }

    if (requiredPerms?.length) {
      const ok = requiredPerms.some((p) => hasPermission(user.permissions, p));
      if (!ok) throw new ForbiddenException('Insufficient permission');
      return true;
    }

    const okRole = requiredRoles!.some((role) => user.roles?.includes(role));
    if (okRole) return true;

    // Custom roles: allow if user holds a permission mapped from required system role
    const okPerm = requiredRoles!.some((role) => {
      const fallbacks = ROLE_PERMISSION_FALLBACK[role] ?? [];
      return fallbacks.some((p) => hasPermission(user.permissions, p));
    });
    if (okPerm) return true;

    throw new ForbiddenException('Insufficient role');
  }
}
