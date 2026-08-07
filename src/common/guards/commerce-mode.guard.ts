import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/database.module';
import { parseCommerceModes } from '../commerce-schema';

export const REQUIRED_COMMERCE_MODES_KEY = 'requiredCommerceModes';

/** Require tenant to have at least one of these commerce modes enabled. */
export const RequireCommerceModes = (...modes: string[]) =>
  SetMetadata(REQUIRED_COMMERCE_MODES_KEY, modes);

/**
 * Nest guard: blocks mode-specific controllers when tenant.settings.commerceModes
 * does not include the required mode. Frontend gating alone is not security.
 */
@Injectable()
export class CommerceModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_COMMERCE_MODES_KEY,
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

    const { modes, setupComplete } = parseCommerceModes(tenant.settings);
    if (!setupComplete || !modes.length) {
      throw new BadRequestException(
        'Shop commerce is not set up — choose what your business does first',
      );
    }
    const ok = required.some((m) => modes.includes(m));
    if (!ok) {
      throw new ForbiddenException(
        `This shop does not have mode(s): ${required.join(', ')}`,
      );
    }
    return true;
  }
}
