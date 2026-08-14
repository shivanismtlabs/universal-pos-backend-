import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountingPeriodStatus } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { Tx } from './mapping-resolve';
import { fiscalYearBounds, parseAccountingSettings } from './settings';

@Injectable()
export class AccountingPeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser) {
    return this.prisma.accountingPeriod.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { startDate: 'desc' },
    });
  }

  async create(
    user: AuthUser,
    dto: { name?: string; startDate: string; endDate: string },
  ) {
    this.assertEdit(user);
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (end < start) throw new BadRequestException('End date must be after start');
    return this.prisma.accountingPeriod.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name?.trim() || `${dto.startDate} → ${dto.endDate}`,
        startDate: start,
        endDate: end,
        status: AccountingPeriodStatus.OPEN,
        createdById: user.userId,
      },
    });
  }

  async close(user: AuthUser, id: string) {
    this.assertClose(user);
    const row = await this.prisma.accountingPeriod.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Period not found');
    if (row.status === AccountingPeriodStatus.CLOSED) {
      throw new BadRequestException('Period already closed');
    }
    const updated = await this.prisma.accountingPeriod.update({
      where: { id },
      data: {
        status: AccountingPeriodStatus.CLOSED,
        closedAt: new Date(),
        closedById: user.userId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'accounting_period',
        entityId: id,
        action: 'accounting.period.closed',
        beforeAfter: { name: row.name },
      },
    });
    return updated;
  }

  async reopen(user: AuthUser, id: string) {
    this.assertClose(user);
    const row = await this.prisma.accountingPeriod.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Period not found');
    if (row.status !== AccountingPeriodStatus.CLOSED) {
      throw new BadRequestException('Period is not closed');
    }
    const updated = await this.prisma.accountingPeriod.update({
      where: { id },
      data: {
        status: AccountingPeriodStatus.OPEN,
        reopenedAt: new Date(),
        reopenedById: user.userId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'accounting_period',
        entityId: id,
        action: 'accounting.period.reopened',
        beforeAfter: { name: row.name },
      },
    });
    return updated;
  }

  async ensureCurrent(tx: Tx, tenantId: string, userId: string, settingsJson: unknown) {
    const settings = parseAccountingSettings(settingsJson);
    const { start, end, name } = fiscalYearBounds(new Date(), settings.fiscalYearStartMonth);
    const existing = await tx.accountingPeriod.findFirst({
      where: {
        tenantId,
        startDate: start,
        endDate: end,
      },
    });
    if (existing) return existing;
    return tx.accountingPeriod.create({
      data: {
        tenantId,
        name,
        startDate: start,
        endDate: end,
        status: AccountingPeriodStatus.OPEN,
        createdById: userId,
      },
    });
  }

  async assertOpen(tenantId: string, entryDate: Date, tx?: Tx) {
    const db = tx ?? this.prisma;
    const closed = await db.accountingPeriod.findFirst({
      where: {
        tenantId,
        status: AccountingPeriodStatus.CLOSED,
        startDate: { lte: entryDate },
        endDate: { gte: entryDate },
      },
    });
    if (closed) {
      throw new BadRequestException(
        `Accounting period "${closed.name}" is closed — posting is not allowed`,
      );
    }
  }

  private assertEdit(user: AuthUser) {
    if (!this.can(user, 'accounting.edit')) {
      throw new ForbiddenException('accounting.edit required');
    }
  }
  private assertClose(user: AuthUser) {
    if (!this.can(user, 'accounting.close_period')) {
      throw new ForbiddenException('accounting.close_period required');
    }
  }
  private can(user: AuthUser, code: string) {
    if (user.roles?.includes('admin') || user.permissions?.includes('*')) return true;
    if (user.roles?.includes('accountant') || user.roles?.includes('manager')) return true;
    return Boolean(user.permissions?.includes(code));
  }
}
