import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/types';
import { JournalService } from './journal.service';
import type { Tx } from './mapping-resolve';
import { D } from './money';
import {
  buildCogsJournal,
  buildCogsReturnJournal,
  buildCustomerPaymentJournal,
  buildExpenseJournal,
  buildPurchaseJournal,
  buildSaleJournal,
  buildSaleReturnJournal,
  buildSupplierPaymentJournal,
  gstFromBreakdown,
  type GstSplit,
  type RevenueSplit,
} from './posting-rules';
import { parseAccountingSettings } from './settings';

@Injectable()
export class AccountingPostingService {
  private readonly log = new Logger(AccountingPostingService.name);

  constructor(private readonly journals: JournalService) {}

  async isEnabled(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true, currencyCode: true },
    });
    return parseAccountingSettings(tenant?.settings, tenant?.currencyCode).enabled;
  }

  async postSale(tx: Tx, user: AuthUser, orderId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const order = await tx.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      include: {
        items: { include: { product: { select: { costPrice: true, kind: true } } } },
        payments: true,
        invoices: true,
      },
    });
    if (!order) return;

    const revenue = this.revenueSplit(order);
    const inv = order.invoices[0];
    const gst = gstFromBreakdown(D(order.taxTotal), {
      cgst: inv ? Number(inv.cgst) : undefined,
      sgst: inv ? Number(inv.sgst) : undefined,
      igst: inv ? Number(inv.igst) : undefined,
    });
    const built = buildSaleJournal({
      basis: cfg.basis,
      orderKind: order.kind,
      subtotal: D(order.subtotal),
      discountTotal: D(order.discountTotal),
      taxTotal: D(order.taxTotal),
      balanceDue: D(order.balanceDue),
      revenue,
      gst,
      payments: order.payments
        .filter((p) => p.status === 'succeeded')
        .map((p) => ({
          method: p.method,
          type: p.type,
          amount: D(p.amount),
        })),
      customerId: order.customerId,
      locationId: order.locationId,
      orderNumber: order.orderNumber,
    });

    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      locationId: order.locationId,
      entryDate: order.createdAt,
      sourceType: built.sourceType,
      sourceId: order.id,
      sourceKey: `SALE:${order.id}`,
      description: built.description,
      lines: built.lines,
      taxFacts: built.taxFacts,
    });

    if (cfg.cogsEnabled && cfg.inventoryAccountingEnabled) {
      let cogs = new Prisma.Decimal(0);
      for (const item of order.items) {
        if (item.itemKind !== 'product') continue;
        const cost = D(item.product?.costPrice);
        cogs = cogs.add(cost.mul(D(item.quantity)));
      }
      const cogsJ = buildCogsJournal({
        cogsAmount: cogs,
        locationId: order.locationId,
        orderNumber: order.orderNumber,
      });
      if (cogsJ) {
        await this.journals.postAutomatic(tx, {
          tenantId: user.tenantId,
          userId: user.userId,
          locationId: order.locationId,
          entryDate: order.createdAt,
          sourceType: cogsJ.sourceType,
          sourceId: order.id,
          description: cogsJ.description,
          lines: cogsJ.lines,
        });
      }
    }
  }

  async postCustomerPayment(tx: Tx, user: AuthUser, paymentId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, tenantId: user.tenantId },
      include: { order: true },
    });
    if (!payment || payment.status !== 'succeeded') return;
    if (payment.type === 'refund' || payment.type === 'deposit_refund') return;
    const built = buildCustomerPaymentJournal({
      basis: cfg.basis,
      method: payment.method,
      amount: D(payment.amount),
      customerId: payment.order.customerId,
      locationId: payment.order.locationId,
      orderNumber: payment.order.orderNumber,
    });
    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      locationId: payment.order.locationId,
      entryDate: payment.createdAt,
      sourceType: built.sourceType,
      sourceId: payment.id,
      description: built.description,
      lines: built.lines,
      taxFacts: built.taxFacts,
    });
  }

  async postExpense(tx: Tx, user: AuthUser, expenseId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const row = await tx.expense.findFirst({
      where: { id: expenseId, tenantId: user.tenantId },
    });
    if (!row) return;
    const tax = D(row.taxAmount);
    const net = row.netAmount != null ? D(row.netAmount) : D(row.amount).sub(tax);
    const gst: GstSplit = gstFromBreakdown(tax, null);
    const built = buildExpenseJournal({
      net,
      tax,
      gst,
      method: row.paymentMethod,
      expenseNumber: row.expenseNumber,
      locationId: row.locationId,
    });
    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      locationId: row.locationId,
      entryDate: row.spentAt,
      sourceType: built.sourceType,
      sourceId: row.id,
      description: built.description,
      lines: built.lines,
      taxFacts: built.taxFacts,
    });
  }

  async postPurchaseInvoice(tx: Tx, user: AuthUser, invoiceId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const inv = await tx.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
    });
    if (!inv) return;
    const isReturn = inv.status === 'credit' || D(inv.grandTotal).lt(0);
    const built = buildPurchaseJournal({
      subtotal: D(inv.subtotal).abs(),
      taxTotal: D(inv.taxTotal).abs(),
      gst: gstFromBreakdown(D(inv.taxTotal).abs(), null),
      isReturn,
      inventoryAccounting: cfg.inventoryAccountingEnabled,
      supplierId: inv.supplierId,
      invoiceNumber: inv.invoiceNumber,
    });
    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      entryDate: inv.invoiceDate,
      sourceType: built.sourceType,
      sourceId: inv.id,
      description: built.description,
      lines: built.lines,
      taxFacts: built.taxFacts,
    });
  }

  async postSupplierPayment(tx: Tx, user: AuthUser, paymentId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const pay = await tx.supplierPayment.findFirst({
      where: { id: paymentId, tenantId: user.tenantId },
    });
    if (!pay) return;
    const built = buildSupplierPaymentJournal({
      amount: D(pay.amount),
      method: pay.method,
      kind: pay.kind === 'refund' ? 'refund' : 'payment',
      supplierId: pay.supplierId,
      reference: pay.reference,
    });
    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      entryDate: pay.paidAt,
      sourceType: built.sourceType,
      sourceId: pay.id,
      description: built.description,
      lines: built.lines,
    });
  }

  async postSaleReturn(tx: Tx, user: AuthUser, returnEventId: string) {
    const cfg = await this.loadSettings(tx, user.tenantId);
    if (!cfg.enabled) return;
    const ev = await tx.returnEvent.findFirst({
      where: { id: returnEventId, tenantId: user.tenantId },
      include: { order: true },
    });
    if (!ev) return;
    const refund = D(ev.refundAmount);
    const order = ev.order;
    const orderNet = D(order.subtotal).sub(D(order.discountTotal)).add(D(order.taxTotal));
    const ratio = orderNet.gt(0) ? refund.div(orderNet) : new Prisma.Decimal(1);
    const tax = D(order.taxTotal).mul(ratio).toDecimalPlaces(2);
    const net = refund.sub(tax);
    const gst = gstFromBreakdown(tax, null);
    const built = buildSaleReturnJournal({
      net,
      tax,
      gst,
      refundMethod: ev.refundMethod || 'cash',
      customerId: order.customerId,
      locationId: order.locationId,
      orderNumber: order.orderNumber,
    });
    await this.journals.postAutomatic(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      locationId: order.locationId,
      entryDate: ev.createdAt,
      sourceType: built.sourceType,
      sourceId: ev.id,
      description: built.description,
      lines: built.lines,
      taxFacts: built.taxFacts,
    });

    if (cfg.cogsEnabled && cfg.inventoryAccountingEnabled) {
      let returnedCogs = new Prisma.Decimal(0);
      const itemsArr = Array.isArray(ev.itemsJson)
        ? (ev.itemsJson as Array<Record<string, unknown>>)
        : [];
      const productIds = itemsArr
        .map((i) => (typeof i.productId === 'string' ? i.productId : null))
        .filter(Boolean) as string[];

      if (productIds.length > 0) {
        const products = await tx.product.findMany({
          where: { tenantId: user.tenantId, id: { in: productIds } },
          select: { id: true, costPrice: true },
        });
        const costMap = new Map(products.map((p) => [p.id, D(p.costPrice ?? 0)]));
        for (const item of itemsArr) {
          if (item.kind === 'replace') continue;
          const cond = String(item.condition ?? 'good');
          const pid = typeof item.productId === 'string' ? item.productId : null;
          const rawQty = item.quantity ?? item.returnQty ?? 0;
          const numQty = typeof rawQty === 'number' || typeof rawQty === 'string' ? rawQty : 0;
          const qty = D(numQty);
          if (pid && qty.gt(0)) {
            const unitCost = costMap.get(pid) ?? new Prisma.Decimal(0);
            returnedCogs = returnedCogs.add(unitCost.mul(qty));
          }
        }
      }

      const cogsReturnJ = buildCogsReturnJournal({
        cogsAmount: returnedCogs,
        locationId: order.locationId,
        orderNumber: order.orderNumber,
      });

      if (cogsReturnJ) {
        await this.journals.postAutomatic(tx, {
          tenantId: user.tenantId,
          userId: user.userId,
          locationId: order.locationId,
          entryDate: ev.createdAt,
          sourceType: cogsReturnJ.sourceType,
          sourceId: ev.id,
          description: cogsReturnJ.description,
          lines: cogsReturnJ.lines,
          taxFacts: [],
        });
      }
    }
  }

  /**
   * Called from POS modules. Throws so the surrounding DB transaction rolls back.
   */
  async safePost(
    tx: Tx,
    user: AuthUser,
    fn: () => Promise<void>,
  ) {
    try {
      await fn();
    } catch (err) {
      this.log.error(err);
      throw err;
    }
  }

  private revenueSplit(order: {
    kind: string;
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    items: Array<{
      itemKind: string;
      lineTotal: Prisma.Decimal;
      product?: { kind?: string | null } | null;
    }>;
  }): RevenueSplit {
    const z = new Prisma.Decimal(0);
    const split: RevenueSplit = { sales: z, service: z, rental: z, subscription: z };
    const merch = D(order.subtotal).sub(D(order.discountTotal));
    const itemSum = order.items.reduce((s, i) => s.add(D(i.lineTotal)), z);
    if (itemSum.lte(0)) {
      if (order.kind === 'rental') split.rental = merch;
      else if (order.kind === 'subscription') split.subscription = merch;
      else if (order.kind === 'service') split.service = merch;
      else split.sales = merch;
      return split;
    }
    for (const item of order.items) {
      const share = merch.mul(D(item.lineTotal)).div(itemSum).toDecimalPlaces(2);
      if (item.itemKind === 'service' || item.product?.kind === 'service') {
        split.service = split.service.add(share);
      } else if (item.itemKind === 'stock_unit' || order.kind === 'rental') {
        split.rental = split.rental.add(share);
      } else if (order.kind === 'subscription') {
        split.subscription = split.subscription.add(share);
      } else {
        split.sales = split.sales.add(share);
      }
    }
    return split;
  }

  private async loadSettings(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true, currencyCode: true },
    });
    return parseAccountingSettings(tenant?.settings, tenant?.currencyCode);
  }
}
