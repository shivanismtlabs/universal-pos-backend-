import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { AccountsService } from './accounts.service';
import { AccountingPeriodsService } from './periods.service';
import { AccountingReportsService } from './reports.service';
import {
  mergeAccountingSettings,
  parseAccountingSettings,
  type AccountingSettings,
} from './settings';

@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly periods: AccountingPeriodsService,
    private readonly reports: AccountingReportsService,
  ) {}

  async getSettings(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { settings: true, currencyCode: true },
    });
    return parseAccountingSettings(tenant?.settings, tenant?.currencyCode);
  }

  async updateSettings(user: AuthUser, patch: Partial<AccountingSettings>) {
    this.assertManage(user);
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { settings: true, currencyCode: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    const prev = parseAccountingSettings(tenant.settings, tenant.currencyCode);
    const next = { ...prev, ...patch };
    const enabling = !prev.enabled && next.enabled;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: user.tenantId },
        data: {
          settings: mergeAccountingSettings(tenant.settings, next) as object,
        },
      });
      if (enabling) {
        await this.accounts.seedChart(tx, user.tenantId, user.userId);
        await this.periods.ensureCurrent(
          tx,
          user.tenantId,
          user.userId,
          mergeAccountingSettings(tenant.settings, next),
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'tenant',
          entityId: user.tenantId,
          action: 'accounting.settings_updated',
          beforeAfter: { before: prev, after: next },
        },
      });
    });
    return this.getSettings(user);
  }

  overview(user: AuthUser) {
    return this.reports.overview(user);
  }

  private assertManage(user: AuthUser) {
    if (
      user.roles?.includes('admin') ||
      user.roles?.includes('manager') ||
      user.roles?.includes('accountant') ||
      user.permissions?.includes('*') ||
      user.permissions?.includes('accounting.edit') ||
      user.permissions?.includes('settings.manage')
    ) {
      return;
    }
    throw new ForbiddenException('accounting.edit required');
  }
}
