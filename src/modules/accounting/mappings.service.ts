import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { MAP } from './constants';

export const MAPPING_CATALOG: Array<{ key: string; label: string; group: string }> = [
  { key: MAP.sales, label: 'Product sales', group: 'Revenue' },
  { key: MAP.service_revenue, label: 'Service revenue', group: 'Revenue' },
  { key: MAP.rental_revenue, label: 'Rental revenue', group: 'Revenue' },
  { key: MAP.subscription_revenue, label: 'Subscription revenue', group: 'Revenue' },
  { key: MAP.sales_return, label: 'Sales returns', group: 'Revenue' },
  { key: MAP.discounts, label: 'Discounts', group: 'Revenue' },
  { key: MAP.cash, label: 'Cash', group: 'Tender' },
  { key: MAP.bank, label: 'Bank', group: 'Tender' },
  { key: MAP.upi, label: 'UPI', group: 'Tender' },
  { key: MAP.card, label: 'Card', group: 'Tender' },
  { key: MAP.wallet, label: 'Wallet', group: 'Tender' },
  { key: MAP.gift_card, label: 'Gift card', group: 'Tender' },
  { key: MAP.store_credit, label: 'Store credit', group: 'Tender' },
  { key: MAP.other_tender, label: 'Other tender', group: 'Tender' },
  { key: MAP.ar, label: 'Accounts receivable', group: 'Balance sheet' },
  { key: MAP.ap, label: 'Accounts payable', group: 'Balance sheet' },
  { key: MAP.inventory, label: 'Inventory', group: 'Balance sheet' },
  { key: MAP.customer_advances, label: 'Customer advances', group: 'Balance sheet' },
  { key: MAP.deposits, label: 'Refundable deposits', group: 'Balance sheet' },
  { key: MAP.retained_earnings, label: 'Retained earnings', group: 'Balance sheet' },
  { key: MAP.output_gst, label: 'Output GST', group: 'Tax' },
  { key: MAP.output_cgst, label: 'Output CGST', group: 'Tax' },
  { key: MAP.output_sgst, label: 'Output SGST', group: 'Tax' },
  { key: MAP.output_igst, label: 'Output IGST', group: 'Tax' },
  { key: MAP.output_cess, label: 'Output CESS', group: 'Tax' },
  { key: MAP.input_gst, label: 'Input GST', group: 'Tax' },
  { key: MAP.input_cgst, label: 'Input CGST', group: 'Tax' },
  { key: MAP.input_sgst, label: 'Input SGST', group: 'Tax' },
  { key: MAP.input_igst, label: 'Input IGST', group: 'Tax' },
  { key: MAP.cogs, label: 'COGS', group: 'Expenses' },
  { key: MAP.purchase, label: 'Purchases', group: 'Expenses' },
  { key: MAP.purchase_return, label: 'Purchase returns', group: 'Expenses' },
  { key: MAP.expense_default, label: 'Default expense', group: 'Expenses' },
];

@Injectable()
export class AccountMappingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, locationId?: string) {
    const scopeKey = locationId || '*';
    const rows = await this.prisma.accountMapping.findMany({
      where: { tenantId: user.tenantId, scopeKey },
      include: {
        account: { select: { id: true, code: true, name: true, type: true } },
      },
      orderBy: { mappingKey: 'asc' },
    });
    const byKey = new Map(rows.map((r) => [r.mappingKey, r]));
    return MAPPING_CATALOG.map((c) => ({
      ...c,
      mapping: byKey.get(c.key) ?? null,
    }));
  }

  async upsert(
    user: AuthUser,
    dto: { mappingKey: string; accountId: string; locationId?: string | null },
  ) {
    this.assertEdit(user);
    const account = await this.prisma.glAccount.findFirst({
      where: { id: dto.accountId, tenantId: user.tenantId },
    });
    if (!account) throw new NotFoundException('Account not found');
    const scopeKey = dto.locationId || '*';
    const row = await this.prisma.accountMapping.upsert({
      where: {
        tenantId_mappingKey_scopeKey: {
          tenantId: user.tenantId,
          mappingKey: dto.mappingKey,
          scopeKey,
        },
      },
      create: {
        tenantId: user.tenantId,
        mappingKey: dto.mappingKey,
        scopeKey,
        locationId: dto.locationId ?? null,
        accountId: dto.accountId,
        createdById: user.userId,
      },
      update: { accountId: dto.accountId, locationId: dto.locationId ?? null },
      include: {
        account: { select: { id: true, code: true, name: true, type: true } },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'account_mapping',
        entityId: row.id,
        action: 'accounting.mapping.updated',
        beforeAfter: {
          mappingKey: dto.mappingKey,
          accountCode: account.code,
          locationId: dto.locationId ?? null,
        },
      },
    });
    return row;
  }

  private assertEdit(user: AuthUser) {
    if (
      user.roles?.includes('admin') ||
      user.roles?.includes('manager') ||
      user.roles?.includes('accountant') ||
      user.permissions?.includes('*') ||
      user.permissions?.includes('accounting.edit')
    ) {
      return;
    }
    throw new ForbiddenException('accounting.edit required');
  }
}
