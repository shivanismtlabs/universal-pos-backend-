import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/database.module';
import {
  hasCapability,
  type CapabilityCode,
} from '../capabilities';

export const REQUIRED_CAPABILITIES_KEY = 'requiredCapabilities';

/** Require tenant to have at least one of these capabilities. */
export const RequireCapabilities = (...codes: CapabilityCode[]) =>
  SetMetadata(REQUIRED_CAPABILITIES_KEY, codes);

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<CapabilityCode[]>(
      REQUIRED_CAPABILITIES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<{
      user?: { tenantId?: string };
    }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('Not authenticated');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new ForbiddenException('Tenant not found');

    const ok = required.some((code) => hasCapability(tenant.settings, code));
    if (!ok) {
      throw new ForbiddenException(
        `This shop does not have capability: ${required.join(' or ')}`,
      );
    }
    return true;
  }
}
