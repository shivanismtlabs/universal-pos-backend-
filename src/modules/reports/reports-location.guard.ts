import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import { assertLocationAccess } from '../../common/location-access';
import type { AuthUser } from '../auth/types';

/**
 * Enforce per-branch report authorization for any endpoint that accepts
 * location filters in query params.
 */
@Injectable()
export class ReportsLocationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      query?: Record<string, unknown>;
      user?: AuthUser;
    }>();
    const user = req.user;
    if (!user?.tenantId) return true;

    const locationIds = this.extractLocationIds(req.query ?? {});
    if (!locationIds.length) return true;

    for (const locationId of locationIds) {
      await assertLocationAccess(this.prisma, user, locationId, {
        requireActive: false,
      });
    }

    return true;
  }

  private extractLocationIds(query: Record<string, unknown>): string[] {
    const values = new Set<string>();

    const locationId = query.locationId;
    if (typeof locationId === 'string' && locationId.trim()) {
      values.add(locationId.trim());
    }

    const locationIds = query.locationIds;
    if (typeof locationIds === 'string' && locationIds.trim()) {
      for (const token of locationIds.split(',')) {
        const value = token.trim();
        if (value) values.add(value);
      }
    }

    return [...values];
  }
}
