import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
  StockLedgerType,
} from '@prisma/client';
import {
  buildTaxProfile,
  computeLineTax,
  resolveProductTaxRatePercent,
} from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { BillingService } from '../billing/billing.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { PaymentsService } from '../payments/payments.service';
import { AccountingPostingService } from '../accounting/posting.service';
import { EnterpriseApprovalsService } from '../enterprise/enterprise-approvals.service';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';
import type { SaleExchangeDto, SaleReturnDto } from './dto/pos.dto';
import {
  computeReturnRefundFromOriginal,
  type ComputedReturnLine,
} from './sale-return-math';
import { reverseHistoricalBaseQty } from '../catalog/pricing-engine';

function money(n: Prisma.Decimal | string | number) {
  return new Prisma.Decimal(n);
}

const RESELLABLE = new Set(['good']);

/** Open return statuses that reserve qty / refundable amount */
const OPEN_RETURN_STATUSES = [
  'pending',
  'requested',
  'approved',
  'processing',
] as const;

const QTY_RESERVE_STATUSES = [
  ...OPEN_RETURN_STATUSES,
  'completed',
] as const;

type ReturnLine = ComputedReturnLine;

@Injectable()
export class SaleReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly loyalty: LoyaltyService,
    private readonly billing: BillingService,
    private readonly accounting: AccountingPostingService,
    private readonly approvals: EnterpriseApprovalsService,
    private readonly stock: StockMutationEngine,
  ) {}

  async saleReturn(user: AuthUser, dto: SaleReturnDto) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        OR: [
          { status: OrderStatus.closed },
          { status: OrderStatus.fulfilled },
          { status: OrderStatus.confirmed, balanceDue: { lte: 0 } },
        ],
      },
      include: {
        items: true,
        payments: true,
        customer: { select: { id: true, storeCreditBalance: true } },
      },
    });
    if (!order) throw new NotFoundException('Closed sale not found');

    const resolvedMethod = this.resolveRefundMethod(dto, order.payments);
    if (
      resolvedMethod === PaymentMethod.store_credit &&
      !order.customerId
    ) {
      throw new BadRequestException(
        'Store credit refund needs a customer on the original sale',
      );
    }

    const existingPay = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existingPay) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        refundPaymentId: existingPay.id,
        replayed: true,
        status: 'completed' as const,
        message: '✓ Return Completed',
        amount: Number(existingPay.amount),
        restocked: [] as Array<{
          stockLevelId: string;
          quantity: number;
          condition: string;
        }>,
        storeCreditBalance: null as number | null,
        returnEventId: null as string | null,
      };
    }

    const existingEvent = await this.prisma.returnEvent.findFirst({
      where: { tenantId: user.tenantId, idempotencyKey: dto.idempotencyKey },
    });
    if (existingEvent) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        returnEventId: existingEvent.id,
        status: existingEvent.status,
        replayed: true,
        amount: existingEvent.refundAmount
          ? Number(existingEvent.refundAmount)
          : null,
        message:
          existingEvent.status === 'completed'
            ? '✓ Return Completed'
            : existingEvent.status === 'requested' ||
                existingEvent.status === 'pending'
              ? 'Return submitted for approval'
              : undefined,
        restocked: [] as Array<{
          stockLevelId: string;
          quantity: number;
          condition: string;
        }>,
        storeCreditBalance: null as number | null,
        refundPaymentId: null as string | null,
      };
    }

    const reasonCode = String(dto.reasonCode ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!reasonCode) {
      throw new BadRequestException('reasonCode is required');
    }

    let reason = await this.prisma.refundReason.findFirst({
      where: {
        tenantId: user.tenantId,
        code: reasonCode,
        isActive: true,
      },
    });
    if (!reason) {
      // Fresh tenants may not have catalog yet — seed defaults then retry
      await this.seedRefundReasons(user);
      reason = await this.prisma.refundReason.findFirst({
        where: {
          tenantId: user.tenantId,
          code: reasonCode,
          isActive: true,
        },
      });
    }
    if (!reason) {
      const available = await this.prisma.refundReason.findMany({
        where: { tenantId: user.tenantId, isActive: true },
        select: { code: true },
        orderBy: { sortOrder: 'asc' },
        take: 20,
      });
      throw new BadRequestException(
        `Unknown refund reason: ${reasonCode}. Allowed: ${available.map((r) => r.code).join(', ') || '(none — call POST /pos/refund-reasons/seed)'}`,
      );
    }
    // Keep dto.reasonCode normalized for downstream writes
    dto.reasonCode = reasonCode;

    if (dto.parentPaymentId) {
      const parent = order.payments.find((p) => p.id === dto.parentPaymentId);
      if (
        !parent ||
        parent.status !== PaymentStatus.succeeded ||
        (parent.type !== PaymentType.payment &&
          parent.type !== PaymentType.deposit)
      ) {
        throw new BadRequestException('Invalid parent payment for refund');
      }
    }

    const alreadyReturned = await this.returnedQtyByLevel(
      user.tenantId,
      order.id,
    );

    for (const ret of dto.items) {
      const soldQty = order.items
        .filter(
          (i) =>
            i.stockLevelId === ret.stockLevelId &&
            i.itemKind === OrderItemKind.product,
        )
        .reduce((s, i) => s + Number(i.quantity), 0);
      if (soldQty <= 0) {
        throw new BadRequestException(
          `Item ${ret.stockLevelId} was not on this sale`,
        );
      }
      const prior = alreadyReturned.get(ret.stockLevelId) ?? 0;
      const remaining = Math.max(0, soldQty - prior);
      if (ret.quantity > remaining + 1e-9) {
        throw new BadRequestException(
          `Cannot return ${ret.quantity} (remaining ${remaining})`,
        );
      }
    }

    let computed: { amount: number; lines: ReturnLine[] };
    try {
      computed = computeReturnRefundFromOriginal({
        orderSubtotal: Number(order.subtotal),
        orderTaxTotal: Number(order.taxTotal),
        orderDiscountTotal: Number(order.discountTotal),
        soldItems: order.items.filter(
          (i) => i.itemKind === OrderItemKind.product,
        ),
        returnItems: dto.items,
      });
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Invalid return lines',
      );
    }

    const refundAmount =
      dto.amount !== undefined ? money(dto.amount) : money(computed.amount);
    if (refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount must be > 0');
    }
    if (
      dto.amount !== undefined &&
      money(dto.amount).gt(money(computed.amount).add(0.009))
    ) {
      throw new BadRequestException(
        `Refund ${dto.amount} exceeds eligible return amount ${computed.amount.toFixed(2)}`,
      );
    }

    const remainingRefundable = await this.remainingRefundableAmount(
      user.tenantId,
      order.id,
      order.payments,
    );
    if (refundAmount.gt(money(remainingRefundable).add(0.009))) {
      throw new BadRequestException(
        `Refund ${refundAmount.toFixed(2)} exceeds remaining refundable ${remainingRefundable.toFixed(2)}`,
      );
    }

    const notes = dto.reason?.trim() || `Reason: ${dto.reasonCode}`;
    const lines = computed.lines;

    const evaled = await this.approvals.evaluate(user, {
      type: 'refund',
      tenantId: user.tenantId,
      amount: Number(refundAmount.toFixed(2)),
      entityType: 'return_event',
      entityId: order.id,
      reason: notes,
    });

    const autoComplete =
      this.isRefundApprover(user) ||
      (await this.withinApprovalThreshold(
        user.tenantId,
        Number(refundAmount.toFixed(2)),
      ));

    if (!autoComplete || evaled.needsApproval) {
      if (evaled.needsApproval) {
        await this.approvals.createRequest(user, {
          type: 'refund',
          tenantId: user.tenantId,
          amount: Number(refundAmount.toFixed(2)),
          entityType: 'order',
          entityId: order.id,
          reason: evaled.reason ?? notes,
          payload: { orderId: order.id, reasonCode: dto.reasonCode },
        });
      }
      const pending = await this.prisma.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          receivedById: user.userId,
          notes,
          status: 'requested',
          reasonCode: dto.reasonCode,
          refundAmount: refundAmount.toFixed(2),
          refundMethod: resolvedMethod,
          itemsJson: await this.buildReturnItemsJson(
            user.tenantId,
            order.items,
            lines,
          ),
          idempotencyKey: dto.idempotencyKey,
          parentPaymentId: dto.parentPaymentId,
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'return_event',
          entityId: pending.id,
          action: 'sale_return.requested',
          beforeAfter: {
            orderId: order.id,
            amount: Number(refundAmount.toFixed(2)),
            lines,
            status: 'requested',
          },
        },
      });
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        returnEventId: pending.id,
        status: 'requested' as const,
        amount: Number(refundAmount.toFixed(2)),
        message: 'Return requested — awaiting approval',
        restocked: [] as Array<{
          stockLevelId: string;
          quantity: number;
          condition: string;
        }>,
        storeCreditBalance: null as number | null,
        refundPaymentId: null as string | null,
      };
    }

    return this.completeSaleReturn(user, {
      order,
      lines,
      refundAmount: Number(refundAmount.toFixed(2)),
      refundMethod: resolvedMethod,
      notes,
      reasonCode: dto.reasonCode,
      idempotencyKey: dto.idempotencyKey,
      approvedById: user.userId,
      parentPaymentId: dto.parentPaymentId,
      markApprovedFirst: true,
    });
  }

  listSaleReturns(user: AuthUser, status?: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    const statusFilter =
      !status || status === 'all'
        ? undefined
        : status === 'pending' || status === 'requested'
          ? { status: { in: ['pending', 'requested'] } }
          : { status };

    return this.prisma.returnEvent
      .findMany({
        where: {
          tenantId: user.tenantId,
          stockUnitId: null,
          ...statusFilter,
        },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              meta: true,
              customer: { select: { fullName: true, phone: true } },
              invoices: {
                select: { id: true, invoiceNumber: true },
                take: 1,
                orderBy: { createdAt: 'desc' },
              },
            },
          },
          receivedBy: { select: { fullName: true } },
          approvedBy: { select: { fullName: true } },
        },
      })
      .then((rows) => ({
        items: rows.map((r) => {
          const meta =
            r.order.meta && typeof r.order.meta === 'object'
              ? (r.order.meta as Record<string, unknown>)
              : {};
          const exchanges = Array.isArray(meta.exchanges)
            ? (meta.exchanges as Array<Record<string, unknown>>)
            : [];
          const linked = exchanges.find((e) => e.returnEventId === r.id) ??
            exchanges[exchanges.length - 1];
          const parsed = this.splitReturnItemsJson(r.itemsJson);
          return {
            id: r.id,
            status: r.status,
            statusLabel:
              r.reasonCode === 'exchange' && r.status === 'completed'
                ? '✓ Exchange Completed'
                : this.statusLabel(r.status),
            reasonCode: r.reasonCode,
            notes: r.notes,
            refundAmount:
              r.refundAmount != null ? Number(r.refundAmount) : null,
            refundMethod: r.refundMethod,
            items: r.itemsJson,
            returnedItems: parsed.returnedItems,
            replacedItems: parsed.replacedItems,
            isExchange:
              r.reasonCode === 'exchange' || parsed.replacedItems.length > 0,
            orderId: r.orderId,
            orderNumber: r.order.orderNumber,
            customerName: r.order.customer?.fullName ?? null,
            receivedBy: r.receivedBy?.fullName ?? null,
            approvedBy: r.approvedBy?.fullName ?? null,
            rejectReason: r.rejectReason,
            createdAt: r.createdAt,
            exchangeOrderId:
              typeof linked?.exchangeOrderId === 'string'
                ? linked.exchangeOrderId
                : null,
            exchangeOrderNumber:
              typeof linked?.exchangeOrderNumber === 'string'
                ? linked.exchangeOrderNumber
                : null,
            invoiceNumber:
              typeof linked?.invoiceNumber === 'string'
                ? linked.invoiceNumber
                : (r.order.invoices[0]?.invoiceNumber ?? null),
          };
        }),
      }));
  }

  async returnedQuantities(user: AuthUser, orderId: string) {
    const map = await this.returnedQtyByLevel(user.tenantId, orderId);
    const remaining = await this.remainingRefundableAmount(
      user.tenantId,
      orderId,
    );
    return {
      orderId,
      byStockLevelId: Object.fromEntries(map.entries()),
      remainingRefundable: remaining,
    };
  }

  async approveSaleReturn(user: AuthUser, returnEventId: string) {
    if (!this.isRefundApprover(user)) {
      throw new BadRequestException('Only managers can approve returns');
    }
    const ev = await this.prisma.returnEvent.findFirst({
      where: {
        id: returnEventId,
        tenantId: user.tenantId,
        status: { in: ['pending', 'requested'] },
      },
    });
    if (!ev) throw new NotFoundException('Pending return not found');

    const order = await this.prisma.order.findFirst({
      where: { id: ev.orderId, tenantId: user.tenantId },
      include: { items: true, payments: true, customer: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const lines = (
      Array.isArray(ev.itemsJson) ? ev.itemsJson : []
    ) as Array<ReturnLine & { kind?: string }>;
    const returnOnly = lines.filter((l) => l.kind !== 'replace');
    const refundAmount = Number(ev.refundAmount ?? 0);
    const remaining = await this.remainingRefundableAmount(
      user.tenantId,
      order.id,
      order.payments,
      ev.id,
    );
    if (refundAmount > remaining + 0.009) {
      throw new BadRequestException(
        `Refund ${refundAmount.toFixed(2)} exceeds remaining refundable ${remaining.toFixed(2)}`,
      );
    }

    await this.prisma.returnEvent.update({
      where: { id: ev.id },
      data: { status: 'approved', approvedById: user.userId },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'return_event',
        entityId: ev.id,
        action: 'sale_return.approved',
        beforeAfter: { status: 'approved', amount: refundAmount },
      },
    });

    return this.completeSaleReturn(user, {
      order,
      lines: returnOnly.map((l) => ({
        stockLevelId: l.stockLevelId as string,
        quantity: Number(l.quantity),
        returnBaseQty: Number(
          (l as any).returnBaseQty ?? (l as any).baseQuantity ?? l.quantity,
        ),
        unitPrice: Number(l.unitPrice ?? 0),
        condition: (l.condition as string) || 'good',
        netShare: Number(l.netShare ?? 0),
        taxShare: Number(l.taxShare ?? 0),
        discountShare: Number(l.discountShare ?? 0),
        refundShare: Number(l.refundShare ?? l.unitPrice ?? 0),
        orderedQuantity:
          (l as any).orderedQuantity != null
            ? Number((l as any).orderedQuantity)
            : undefined,
        orderedUnitSymbol: (l as any).orderedUnitSymbol ?? undefined,
        baseQuantity:
          (l as any).baseQuantity != null
            ? Number((l as any).baseQuantity)
            : undefined,
        baseUnitSymbol: (l as any).baseUnitSymbol ?? undefined,
        priceQuantity:
          (l as any).priceQuantity != null
            ? Number((l as any).priceQuantity)
            : undefined,
        priceUnitSymbol: (l as any).priceUnitSymbol ?? undefined,
      })),
      refundAmount,
      refundMethod: (ev.refundMethod as PaymentMethod) || PaymentMethod.cash,
      notes: ev.notes || 'Approved return',
      reasonCode: ev.reasonCode || undefined,
      idempotencyKey: ev.idempotencyKey || `approve-${ev.id}`,
      approvedById: user.userId,
      existingEventId: ev.id,
      parentPaymentId: ev.parentPaymentId || undefined,
      markApprovedFirst: false,
    });
  }

  async rejectSaleReturn(
    user: AuthUser,
    returnEventId: string,
    reason?: string,
  ) {
    if (!this.isRefundApprover(user)) {
      throw new BadRequestException('Only managers can reject returns');
    }
    const ev = await this.prisma.returnEvent.findFirst({
      where: {
        id: returnEventId,
        tenantId: user.tenantId,
        status: { in: ['pending', 'requested'] },
      },
    });
    if (!ev) throw new NotFoundException('Pending return not found');
    await this.prisma.returnEvent.update({
      where: { id: ev.id },
      data: {
        status: 'rejected',
        approvedById: user.userId,
        rejectReason: reason?.trim() || null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'return_event',
        entityId: ev.id,
        action: 'sale_return.rejected',
        beforeAfter: { reason: reason ?? null },
      },
    });
    return { id: ev.id, status: 'rejected' as const };
  }

  listRefundReasons(user: AuthUser, appliesTo?: string) {
    return this.prisma.refundReason.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        ...(appliesTo
          ? {
              OR: [{ appliesTo }, { appliesTo: 'both' }],
            }
          : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  createRefundReason(
    user: AuthUser,
    dto: {
      code: string;
      label: string;
      sortOrder?: number;
      appliesTo?: string;
    },
  ) {
    return this.prisma.refundReason.create({
      data: {
        tenantId: user.tenantId,
        code: dto.code.trim().toLowerCase().replace(/\s+/g, '_'),
        label: dto.label.trim(),
        sortOrder: dto.sortOrder ?? 0,
        appliesTo: dto.appliesTo?.trim() || 'customer',
      },
    });
  }

  async seedRefundReasons(user: AuthUser) {
    const defaults = [
      { code: 'defective', label: 'Defective product', sortOrder: 1, appliesTo: 'customer' },
      { code: 'damaged', label: 'Damaged product', sortOrder: 2, appliesTo: 'both' },
      { code: 'wrong_item', label: 'Wrong product', sortOrder: 3, appliesTo: 'customer' },
      { code: 'wrong_size', label: 'Wrong size / size issue', sortOrder: 4, appliesTo: 'customer' },
      { code: 'size_issue', label: 'Size issue', sortOrder: 4, appliesTo: 'customer' },
      { code: 'wrong_color', label: 'Wrong color', sortOrder: 5, appliesTo: 'customer' },
      { code: 'not_as_expected', label: 'Product not as expected', sortOrder: 6, appliesTo: 'customer' },
      { code: 'customer_changed_mind', label: 'Customer changed mind', sortOrder: 7, appliesTo: 'customer' },
      { code: 'duplicate', label: 'Duplicate purchase', sortOrder: 8, appliesTo: 'customer' },
      { code: 'quality', label: 'Quality issue', sortOrder: 9, appliesTo: 'both' },
      { code: 'exchange', label: 'Exchange', sortOrder: 10, appliesTo: 'customer' },
      { code: 'supplier_damaged', label: 'Damaged on arrival', sortOrder: 11, appliesTo: 'supplier' },
      { code: 'supplier_wrong', label: 'Wrong goods from supplier', sortOrder: 12, appliesTo: 'supplier' },
      { code: 'supplier_excess', label: 'Excess / over-shipment', sortOrder: 13, appliesTo: 'supplier' },
      { code: 'other', label: 'Other', sortOrder: 99, appliesTo: 'both' },
    ];
    for (const d of defaults) {
      await this.prisma.refundReason.upsert({
        where: {
          tenantId_code: { tenantId: user.tenantId, code: d.code },
        },
        create: { tenantId: user.tenantId, ...d },
        update: {
          label: d.label,
          isActive: true,
          sortOrder: d.sortOrder,
          appliesTo: d.appliesTo,
        },
      });
    }
    return this.listRefundReasons(user);
  }

  /**
   * Exchange: do not mutate original invoice.
   * Return old → restock → NEW order + invoice (central tax) → net settle.
   */
  async saleExchange(user: AuthUser, dto: SaleExchangeDto) {
    if (!this.isRefundApprover(user)) {
      throw new BadRequestException(
        'Exchanges require manager / admin / accountant',
      );
    }

    const existingCredit = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: `${dto.idempotencyKey}:exchange-credit-in`,
        },
      },
    });
    if (existingCredit?.orderId) {
      const existingExchange = await this.prisma.order.findFirst({
        where: { id: existingCredit.orderId, tenantId: user.tenantId },
        include: {
          invoices: { take: 1, orderBy: { createdAt: 'desc' } },
        },
      });
      if (existingExchange) {
        const meta =
          existingExchange.meta && typeof existingExchange.meta === 'object'
            ? (existingExchange.meta as Record<string, unknown>)
            : {};
        return {
          replayed: true,
          message: '✓ Exchange Completed',
          return: {
            returnEventId:
              typeof meta.returnEventId === 'string'
                ? meta.returnEventId
                : null,
            status: 'completed',
          },
          replacement: {
            orderId: existingExchange.id,
            orderNumber: existingExchange.orderNumber,
            invoiceId: existingExchange.invoices[0]?.id ?? null,
            invoiceNumber: existingExchange.invoices[0]?.invoiceNumber ?? null,
            replaceTotal:
              Number(existingExchange.subtotal) +
              Number(existingExchange.taxTotal),
            returnAmount: Number(meta.returnAmount ?? 0),
            net: Number(meta.exchangeNet ?? 0),
            balanceDue: Number(existingExchange.balanceDue),
          },
          links: {
            originalOrderId: dto.orderId,
            returnEventId:
              typeof meta.returnEventId === 'string'
                ? meta.returnEventId
                : null,
            exchangeOrderId: existingExchange.id,
            invoiceId: existingExchange.invoices[0]?.id ?? null,
          },
        };
      }
    }

    const existingExchange = await this.prisma.order.findFirst({
      where: {
        tenantId: user.tenantId,
        meta: {
          path: ['exchangeIdempotencyKey'],
          equals: dto.idempotencyKey,
        },
      },
      include: {
        invoices: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    if (existingExchange) {
      const meta =
        existingExchange.meta && typeof existingExchange.meta === 'object'
          ? (existingExchange.meta as Record<string, unknown>)
          : {};
      return {
        replayed: true,
        message: '✓ Exchange Completed',
        return: {
          returnEventId:
            typeof meta.returnEventId === 'string' ? meta.returnEventId : null,
          status: 'completed',
        },
        replacement: {
          orderId: existingExchange.id,
          orderNumber: existingExchange.orderNumber,
          invoiceId: existingExchange.invoices[0]?.id ?? null,
          invoiceNumber: existingExchange.invoices[0]?.invoiceNumber ?? null,
          replaceTotal:
            Number(existingExchange.subtotal) +
            Number(existingExchange.taxTotal),
          returnAmount: Number(meta.returnAmount ?? 0),
          net: Number(meta.exchangeNet ?? 0),
          balanceDue: Number(existingExchange.balanceDue),
        },
        links: {
          originalOrderId: dto.orderId,
          returnEventId:
            typeof meta.returnEventId === 'string' ? meta.returnEventId : null,
          exchangeOrderId: existingExchange.id,
          invoiceId: existingExchange.invoices[0]?.id ?? null,
        },
      };
    }

    const original = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        OR: [
          { status: OrderStatus.closed },
          { status: OrderStatus.fulfilled },
          { status: OrderStatus.confirmed, balanceDue: { lte: 0 } },
        ],
      },
      include: { items: true, payments: true },
    });
    if (!original) throw new NotFoundException('Closed sale not found');

    const alreadyReturned = await this.returnedQtyByLevel(
      user.tenantId,
      original.id,
    );
    for (const ret of dto.returnItems) {
      const soldQty = original.items
        .filter(
          (i) =>
            i.stockLevelId === ret.stockLevelId &&
            i.itemKind === OrderItemKind.product,
        )
        .reduce((s, i) => s + Number(i.quantity), 0);
      const remaining = Math.max(
        0,
        soldQty - (alreadyReturned.get(ret.stockLevelId) ?? 0),
      );
      if (ret.quantity > remaining + 1e-9) {
        throw new BadRequestException(
          `Cannot return ${ret.quantity} (remaining ${remaining})`,
        );
      }
    }

    let computed: { amount: number; lines: ReturnLine[] };
    try {
      computed = computeReturnRefundFromOriginal({
        orderSubtotal: Number(original.subtotal),
        orderTaxTotal: Number(original.taxTotal),
        orderDiscountTotal: Number(original.discountTotal),
        soldItems: original.items.filter(
          (i) => i.itemKind === OrderItemKind.product,
        ),
        returnItems: dto.returnItems,
      });
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Invalid return lines',
      );
    }
    const returnAmount = computed.amount;
    if (returnAmount <= 0) {
      throw new BadRequestException('Return value must be > 0');
    }

    const remainingRefundable = await this.remainingRefundableAmount(
      user.tenantId,
      original.id,
      original.payments,
    );
    if (returnAmount > remainingRefundable + 0.009) {
      throw new BadRequestException(
        `Return value ${returnAmount.toFixed(2)} exceeds remaining refundable ${remainingRefundable.toFixed(2)}`,
      );
    }

    const levels = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        id: { in: dto.replaceItems.map((i) => i.stockLevelId) },
      },
      include: {
        product: {
          select: { id: true, name: true, taxCode: true, meta: true },
        },
      },
    });
    const levelMap = new Map(levels.map((l) => [l.id, l]));
    for (const item of dto.replaceItems) {
      const level = levelMap.get(item.stockLevelId);
      if (!level) {
        throw new BadRequestException(
          `Stock level not found: ${item.stockLevelId}`,
        );
      }
      if (Number(level.qtyOnHand) < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for ${level.product.name}`,
        );
      }
    }

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { taxMode: true, taxId: true, settings: true },
    });
    const taxProfile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId,
      settings: tenant.settings,
    });

    const notes = dto.reason?.trim() || 'Product exchange';
    const reasonCode = dto.reasonCode || 'exchange';

    const exchangeItemsJson = await this.buildReturnItemsJson(
      user.tenantId,
      original.items,
      computed.lines,
      dto.replaceItems,
    );

    const result = await this.prisma.$transaction(
      async (tx) => {
        // --- 1) Return old product (restock) — no cash refund yet ---
        for (const line of computed.lines) {
          await this.restockLine(tx, user, original, line, notes);
        }

        const returnEvent = await tx.returnEvent.create({
          data: {
            tenantId: user.tenantId,
            orderId: original.id,
            receivedById: user.userId,
            approvedById: user.userId,
            notes,
            status: 'processing',
            reasonCode,
            refundAmount: returnAmount.toFixed(2),
            refundMethod: PaymentMethod.other,
            itemsJson: exchangeItemsJson,
            idempotencyKey: `${dto.idempotencyKey}:return`,
          },
        });

        // --- 2) New sale order (does not modify original) ---
        const orderNumber = `EX-${Date.now().toString(36).toUpperCase()}`;
        const exchangeOrder = await tx.order.create({
          data: {
            tenantId: user.tenantId,
            locationId: original.locationId,
            customerId: original.customerId,
            orderNumber,
            kind: OrderKind.sale,
            status: OrderStatus.confirmed,
            createdById: user.userId,
            meta: {
              exchangeOfOrderId: original.id,
              exchangeOfOrderNumber: original.orderNumber,
              exchangeIdempotencyKey: dto.idempotencyKey,
              returnEventId: returnEvent.id,
              returnAmount,
            },
          },
        });

        let subtotal = money(0);
        let taxTotal = money(0);

        for (const item of dto.replaceItems) {
          const level = levelMap.get(item.stockLevelId)!;
          const price = item.unitPrice ?? Number(level.sellPrice ?? 0);
          const qty = item.quantity;
          const lineGross = money(price).mul(qty);
          const productRatePct = resolveProductTaxRatePercent({
            taxCode: level.product.taxCode,
            meta: level.product.meta,
          });
          const taxed = computeLineTax(taxProfile, {
            lineGross,
            ...(productRatePct != null
              ? { rate: productRatePct / 100 }
              : {}),
          });

          const updated = await tx.stockLevel.update({
            where: { id: level.id },
            data: { qtyOnHand: { decrement: qty } },
          });
          await tx.stockLedgerEntry.create({
            data: {
              tenantId: user.tenantId,
              locationId: level.locationId,
              productId: level.productId,
              stockLevelId: level.id,
              type: StockLedgerType.sale,
              qtyDelta: -qty,
              qtyAfter: Number(updated.qtyOnHand),
              reason: `Exchange replacement for ${original.orderNumber}`,
              referenceType: 'exchange_order',
              referenceId: exchangeOrder.id,
              actorUserId: user.userId,
            },
          });
          await tx.orderItem.create({
            data: {
              tenantId: user.tenantId,
              orderId: exchangeOrder.id,
              itemKind: OrderItemKind.product,
              productId: level.product.id,
              stockLevelId: level.id,
              description: level.product.name,
              quantity: qty,
              unitPrice: price.toFixed(2),
              lineTotal: taxed.lineTotal.toFixed(2),
              taxAmount: taxed.taxAmount.toFixed(2),
              meta: {
                taxRate:
                  productRatePct != null
                    ? productRatePct / 100
                    : taxProfile.rate,
                taxInclusive: taxProfile.inclusive,
                taxCode: level.product.taxCode ?? null,
                exchangeOfOrderId: original.id,
              },
            },
          });
          subtotal = subtotal.add(taxed.lineTotal);
          taxTotal = taxTotal.add(taxed.taxAmount);
        }

        await tx.order.update({
          where: { id: exchangeOrder.id },
          data: {
            subtotal: subtotal.toFixed(2),
            taxTotal: taxTotal.toFixed(2),
            discountTotal: '0',
            balanceDue: subtotal.add(taxTotal).toFixed(2),
          },
        });

        const replaceTotal = Number(subtotal.add(taxTotal).toFixed(2));
        const net = Number(money(replaceTotal).sub(returnAmount).toFixed(2));

        // --- 3) Invoice via billing (central tax snapshot) ---
        const invoice = await this.billing.createInvoiceInTx(
          tx,
          user,
          {
            id: exchangeOrder.id,
            subtotal: subtotal.toFixed(2),
            taxTotal: taxTotal.toFixed(2),
          },
          taxProfile,
          {},
        );

        // --- 4) Settle: exchange credit + collect OR refund surplus ---
        const creditApply = Math.min(returnAmount, replaceTotal);
        if (creditApply > 0.009) {
          await tx.payment.create({
            data: {
              tenantId: user.tenantId,
              orderId: original.id,
              type: PaymentType.refund,
              method: PaymentMethod.other,
              amount: creditApply.toFixed(2),
              status: PaymentStatus.succeeded,
              idempotencyKey: `${dto.idempotencyKey}:exchange-credit-out`,
              takenByUserId: user.userId,
              gatewayPayload: {
                source: 'sale_exchange_credit',
                exchangeOrderId: exchangeOrder.id,
                returnEventId: returnEvent.id,
              },
            },
          });
          await tx.payment.create({
            data: {
              tenantId: user.tenantId,
              orderId: exchangeOrder.id,
              type: PaymentType.payment,
              method: PaymentMethod.other,
              amount: creditApply.toFixed(2),
              status: PaymentStatus.succeeded,
              idempotencyKey: `${dto.idempotencyKey}:exchange-credit-in`,
              takenByUserId: user.userId,
              gatewayPayload: {
                source: 'sale_exchange_credit',
                originalOrderId: original.id,
                returnEventId: returnEvent.id,
              },
            },
          });
        }

        if (net > 0.009) {
          if (
            dto.settleMethod === PaymentMethod.store_credit
          ) {
            if (!original.customerId) {
              throw new BadRequestException(
                'Store credit payment needs a customer on the original sale',
              );
            }
            const cust = await tx.customer.findFirst({
              where: { id: original.customerId, tenantId: user.tenantId },
              select: { storeCreditBalance: true },
            });
            const bal = Number(cust?.storeCreditBalance ?? 0);
            if (bal + 1e-9 < net) {
              throw new BadRequestException(
                `Insufficient store credit (have ${bal.toFixed(2)}, need ${net.toFixed(2)})`,
              );
            }
            const nextBal = Number((bal - net).toFixed(2));
            await tx.customer.update({
              where: { id: original.customerId },
              data: { storeCreditBalance: nextBal.toFixed(2) },
            });
            await tx.storeCreditLedgerEntry.create({
              data: {
                tenantId: user.tenantId,
                customerId: original.customerId,
                kind: 'debit',
                amount: net.toFixed(2),
                balanceAfter: nextBal.toFixed(2),
                orderId: exchangeOrder.id,
                note: 'Applied to exchange new invoice',
                actorUserId: user.userId,
              },
            });
          }
          await tx.payment.create({
            data: {
              tenantId: user.tenantId,
              orderId: exchangeOrder.id,
              type: PaymentType.payment,
              method: dto.settleMethod,
              amount: net.toFixed(2),
              status: PaymentStatus.succeeded,
              idempotencyKey: `${dto.idempotencyKey}:settle`,
              takenByUserId: user.userId,
              gatewayPayload: { source: 'sale_exchange_collect' },
            },
          });
        } else if (net < -0.009) {
          const surplus = Math.abs(net);
          if (
            dto.settleMethod === PaymentMethod.store_credit &&
            !original.customerId
          ) {
            throw new BadRequestException(
              'Store credit refund needs a customer on the original sale',
            );
          }
          await tx.payment.create({
            data: {
              tenantId: user.tenantId,
              orderId: original.id,
              type: PaymentType.refund,
              method: dto.settleMethod,
              amount: surplus.toFixed(2),
              status: PaymentStatus.succeeded,
              idempotencyKey: `${dto.idempotencyKey}:surplus-refund`,
              takenByUserId: user.userId,
              gatewayPayload: {
                source: 'sale_exchange_surplus',
                exchangeOrderId: exchangeOrder.id,
                returnEventId: returnEvent.id,
              },
            },
          });
          if (
            dto.settleMethod === PaymentMethod.store_credit &&
            original.customerId
          ) {
            const cust = await tx.customer.findFirst({
              where: { id: original.customerId, tenantId: user.tenantId },
              select: { storeCreditBalance: true },
            });
            const bal = Number(cust?.storeCreditBalance ?? 0);
            const nextBal = Number((bal + surplus).toFixed(2));
            await tx.customer.update({
              where: { id: original.customerId },
              data: { storeCreditBalance: nextBal.toFixed(2) },
            });
            await tx.storeCreditLedgerEntry.create({
              data: {
                tenantId: user.tenantId,
                customerId: original.customerId,
                kind: 'credit',
                amount: surplus.toFixed(2),
                balanceAfter: nextBal.toFixed(2),
                orderId: original.id,
                note: 'Exchange surplus to store credit',
                actorUserId: user.userId,
              },
            });
          }
        }

        await this.paymentsService.recalculateBalance(
          tx,
          user.tenantId,
          original.id,
        );
        await this.paymentsService.recalculateBalance(
          tx,
          user.tenantId,
          exchangeOrder.id,
        );

        const finalEx = await tx.order.findFirstOrThrow({
          where: { id: exchangeOrder.id },
          select: { balanceDue: true },
        });
        if (money(finalEx.balanceDue).gt(0.009)) {
          throw new BadRequestException(
            'Exchange billing failed — balance remains on new invoice',
          );
        }

        await tx.order.update({
          where: { id: exchangeOrder.id },
          data: {
            status: OrderStatus.closed,
            meta: {
              exchangeOfOrderId: original.id,
              exchangeOfOrderNumber: original.orderNumber,
              exchangeIdempotencyKey: dto.idempotencyKey,
              returnEventId: returnEvent.id,
              returnAmount,
              exchangeNet: net,
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
            },
          },
        });

        await tx.returnEvent.update({
          where: { id: returnEvent.id },
          data: {
            status: 'completed',
            notes: `${notes} → exchange ${orderNumber}`,
          },
        });

        // Link on original order meta (append, do not rewrite invoice)
        const prevMeta =
          original.meta && typeof original.meta === 'object'
            ? (original.meta as Record<string, unknown>)
            : {};
        await tx.order.update({
          where: { id: original.id },
          data: {
            meta: {
              ...prevMeta,
              exchanges: [
                ...((Array.isArray(prevMeta.exchanges)
                  ? prevMeta.exchanges
                  : []) as unknown[]),
                {
                  returnEventId: returnEvent.id,
                  exchangeOrderId: exchangeOrder.id,
                  exchangeOrderNumber: orderNumber,
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  net,
                  at: new Date().toISOString(),
                },
              ],
            } as Prisma.InputJsonValue,
          },
        });

        if (original.customerId) {
          await this.loyalty.clawbackEarnOnReturnInTx(tx, {
            tenantId: user.tenantId,
            customerId: original.customerId,
            orderId: original.id,
            refundAmount: returnAmount,
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'return_event',
            entityId: returnEvent.id,
            action: 'sale_exchange.completed',
            beforeAfter: {
              originalOrderId: original.id,
              returnEventId: returnEvent.id,
              exchangeOrderId: exchangeOrder.id,
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              returnAmount,
              replaceTotal,
              net,
            },
          },
        });

        return {
          returnEventId: returnEvent.id,
          orderId: exchangeOrder.id,
          orderNumber,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          replaceTotal,
          returnAmount,
          net,
          balanceDue: Number(finalEx.balanceDue),
        };
      },
      { timeout: 60_000 },
    );

    return {
      message: '✓ Exchange Completed',
      return: {
        returnEventId: result.returnEventId,
        status: 'completed',
        amount: result.returnAmount,
      },
      replacement: {
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        replaceTotal: result.replaceTotal,
        returnAmount: result.returnAmount,
        net: result.net,
        balanceDue: result.balanceDue,
      },
      links: {
        originalOrderId: original.id,
        returnEventId: result.returnEventId,
        exchangeOrderId: result.orderId,
        invoiceId: result.invoiceId,
      },
    };
  }

  private resolveRefundMethod(
    dto: SaleReturnDto,
    payments: Array<{
      id: string;
      method: PaymentMethod;
      type: PaymentType;
      status: PaymentStatus;
      amount: Prisma.Decimal;
    }>,
  ): PaymentMethod {
    if (dto.refundMethod !== 'original') {
      return dto.refundMethod as PaymentMethod;
    }
    if (dto.parentPaymentId) {
      const parent = payments.find((p) => p.id === dto.parentPaymentId);
      if (parent) return parent.method;
    }
    const primary = payments
      .filter(
        (p) =>
          p.status === PaymentStatus.succeeded &&
          (p.type === PaymentType.payment || p.type === PaymentType.deposit) &&
          p.method !== PaymentMethod.store_credit,
      )
      .sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    if (!primary) {
      throw new BadRequestException(
        'No original payment method found on this sale',
      );
    }
    return primary.method;
  }

  private statusLabel(status: string) {
    switch (status) {
      case 'requested':
      case 'pending':
        return 'Requested';
      case 'approved':
        return 'Approved';
      case 'processing':
        return 'Processing';
      case 'completed':
        return '✓ Return Completed';
      case 'rejected':
        return 'Rejected';
      default:
        return status;
    }
  }

  private isRefundApprover(user: AuthUser) {
    return user.roles.some(
      (r) => r === 'admin' || r === 'manager' || r === 'accountant',
    );
  }

  private async withinApprovalThreshold(tenantId: string, amount: number) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings =
      tenant?.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const returns =
      settings.returns && typeof settings.returns === 'object'
        ? (settings.returns as Record<string, unknown>)
        : {};
    const raw = returns.approvalThresholdAmount;
    const threshold =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw)
          : 0;
    if (!Number.isFinite(threshold) || threshold <= 0) return false;
    return amount <= threshold + 1e-9;
  }

  private async remainingRefundableAmount(
    tenantId: string,
    orderId: string,
    payments?: Array<{
      type: PaymentType;
      status: PaymentStatus;
      amount: Prisma.Decimal | string | number;
    }>,
    excludeOpenEventId?: string,
  ) {
    const pays =
      payments ??
      (await this.prisma.payment.findMany({
        where: { tenantId, orderId },
        select: { type: true, status: true, amount: true },
      }));
    let paid = 0;
    let refunded = 0;
    for (const p of pays) {
      if (p.status !== PaymentStatus.succeeded) continue;
      const amt = Math.abs(Number(p.amount));
      if (
        p.type === PaymentType.payment ||
        p.type === PaymentType.deposit
      ) {
        paid += amt;
      } else if (
        p.type === PaymentType.refund ||
        p.type === PaymentType.deposit_refund
      ) {
        refunded += amt;
      }
    }
    const open = await this.prisma.returnEvent.findMany({
      where: {
        tenantId,
        orderId,
        status: { in: [...OPEN_RETURN_STATUSES] },
        stockUnitId: null,
        ...(excludeOpenEventId
          ? { id: { not: excludeOpenEventId } }
          : {}),
      },
      select: { refundAmount: true },
    });
    const openAmt = open.reduce(
      (s, e) => s + Number(e.refundAmount ?? 0),
      0,
    );
    return Math.max(0, Number((paid - refunded - openAmt).toFixed(2)));
  }

  private async returnedQtyByLevel(tenantId: string, orderId: string) {
    const events = await this.prisma.returnEvent.findMany({
      where: {
        tenantId,
        orderId,
        status: { in: [...QTY_RESERVE_STATUSES] },
        stockUnitId: null,
      },
      select: { itemsJson: true },
    });
    const map = new Map<string, number>();
    for (const ev of events) {
      const lines = Array.isArray(ev.itemsJson)
        ? (ev.itemsJson as Array<{
            stockLevelId?: string;
            quantity?: number;
            returnBaseQty?: number;
            baseQuantity?: number;
            kind?: string;
          }>)
        : [];
      for (const l of lines) {
        // Exchange events store return + replace rows; only returned qty reserves.
        if (l.kind === 'replace') continue;
        if (!l.stockLevelId) continue;
        const returnedBase = l.returnBaseQty ?? l.baseQuantity ?? l.quantity ?? 0;
        if (returnedBase <= 0) continue;
        map.set(
          l.stockLevelId,
          (map.get(l.stockLevelId) ?? 0) + Number(returnedBase),
        );
      }
    }
    return map;
  }

  private async restockLine(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    order: { id: string; orderNumber: string },
    line: ReturnLine,
    notes: string,
  ) {
    const level = await tx.stockLevel.findFirst({
      where: { id: line.stockLevelId, tenantId: user.tenantId },
    });
    if (!level) {
      throw new BadRequestException(
        `Stock level not found: ${line.stockLevelId}`,
      );
    }
    const originals = await tx.orderItem.findMany({
      where: {
        tenantId: user.tenantId,
        orderId: order.id,
        stockLevelId: line.stockLevelId,
      },
      select: {
        quantity: true,
        orderedQuantity: true,
        baseQuantity: true,
      },
    });
    const orig = originals[0];
    let restockQty = line.returnBaseQty ?? line.quantity;
    if (orig && line.returnBaseQty == null) {
      const ordered = orig.orderedQuantity ?? orig.quantity;
      const base = orig.baseQuantity ?? orig.quantity;
      restockQty = reverseHistoricalBaseQty({
        originalOrderedQty: ordered,
        originalBaseQty: base,
        returnOrderedQty: line.quantity,
      }).toNumber();
    }
    const resellable = RESELLABLE.has(line.condition || 'good');
    const recipe = await this.stock.hasRecipeExplosion(
      tx,
      user.tenantId,
      level.productId,
    );
    if (recipe) {
      if (resellable) {
        await this.stock.restoreForParent(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: level.locationId,
          productId: level.productId,
          parentQty: restockQty,
          referenceType: 'customer_return',
          referenceId: order.id,
        });
      }
      return;
    }
    if (resellable) {
      await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: level.locationId,
        stockLevelId: level.id,
        qty: restockQty,
        type: StockLedgerType.customer_return,
        reason: notes,
        referenceType: 'customer_return',
        referenceId: order.id,
        skipComponentExplosion: true,
      });
    } else {
      await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: level.locationId,
        stockLevelId: level.id,
        qty: 0,
        type: StockLedgerType.damage,
        damageDelta: restockQty,
        reason: notes,
        referenceType: 'customer_return',
        referenceId: order.id,
        skipComponentExplosion: true,
        allowNegative: true,
      });
    }
  }

  private async completeSaleReturn(
    user: AuthUser,
    args: {
      order: {
        id: string;
        orderNumber: string;
        customerId: string | null;
        meta?: unknown;
        items?: Array<{
          stockLevelId: string | null;
          description: string | null;
        }>;
      };
      lines: ReturnLine[];
      refundAmount: number;
      refundMethod: PaymentMethod;
      notes: string;
      reasonCode?: string;
      idempotencyKey: string;
      approvedById: string;
      existingEventId?: string;
      parentPaymentId?: string;
      markApprovedFirst?: boolean;
    },
  ) {
    if (args.refundAmount <= 0) {
      throw new BadRequestException('Refund amount must be > 0');
    }

    const newEventItemsJson = args.existingEventId
      ? null
      : await this.buildReturnItemsJson(
          user.tenantId,
          args.order.items ?? [],
          args.lines,
        );

    const outcome = await this.prisma.$transaction(async (tx) => {
      let returnEventId = args.existingEventId;

      if (args.existingEventId) {
        if (args.markApprovedFirst) {
          await tx.returnEvent.update({
            where: { id: args.existingEventId },
            data: {
              status: 'approved',
              approvedById: args.approvedById,
            },
          });
        }
        await tx.returnEvent.update({
          where: { id: args.existingEventId },
          data: {
            status: 'processing',
            approvedById: args.approvedById,
            notes: args.notes,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'return_event',
            entityId: args.existingEventId,
            action: 'sale_return.processing',
            beforeAfter: { status: 'processing' },
          },
        });
      } else {
        const created = await tx.returnEvent.create({
          data: {
            tenantId: user.tenantId,
            orderId: args.order.id,
            receivedById: user.userId,
            approvedById: args.approvedById,
            notes: args.notes,
            status: 'processing',
            reasonCode: args.reasonCode,
            refundAmount: args.refundAmount.toFixed(2),
            refundMethod: args.refundMethod,
            itemsJson: newEventItemsJson!,
            idempotencyKey: args.idempotencyKey,
            parentPaymentId: args.parentPaymentId,
          },
        });
        returnEventId = created.id;
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'return_event',
            entityId: created.id,
            action: 'sale_return.processing',
            beforeAfter: {
              status: 'processing',
              prior: args.markApprovedFirst ? 'approved' : 'requested',
            },
          },
        });
      }

      for (const line of args.lines) {
        await this.restockLine(tx, user, args.order, line, args.notes);
      }

      const pay = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: args.order.id,
          type: PaymentType.refund,
          method: args.refundMethod,
          amount: args.refundAmount.toFixed(2),
          status: PaymentStatus.succeeded,
          idempotencyKey: args.idempotencyKey,
          takenByUserId: user.userId,
          gatewayPayload: {
            parentPaymentId: args.parentPaymentId ?? null,
            returnEventId: returnEventId ?? null,
            source: 'sale_return',
          },
        },
      });

      if (
        args.refundMethod === PaymentMethod.store_credit &&
        args.order.customerId
      ) {
        const cust = await tx.customer.findFirst({
          where: { id: args.order.customerId, tenantId: user.tenantId },
          select: { storeCreditBalance: true },
        });
        const bal = Number(cust?.storeCreditBalance ?? 0);
        const nextBal = Number((bal + args.refundAmount).toFixed(2));
        await tx.customer.update({
          where: { id: args.order.customerId },
          data: { storeCreditBalance: nextBal.toFixed(2) },
        });
        await tx.storeCreditLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            customerId: args.order.customerId,
            kind: 'credit',
            amount: args.refundAmount.toFixed(2),
            balanceAfter: nextBal.toFixed(2),
            orderId: args.order.id,
            note: 'POS refund to store credit',
            actorUserId: user.userId,
          },
        });
      }

      if (args.order.customerId) {
        await this.loyalty.clawbackEarnOnReturnInTx(tx, {
          tenantId: user.tenantId,
          customerId: args.order.customerId,
          orderId: args.order.id,
          refundAmount: args.refundAmount,
        });
      }

      await this.paymentsService.recalculateBalance(
        tx,
        user.tenantId,
        args.order.id,
      );

      await tx.returnEvent.update({
        where: { id: returnEventId! },
        data: { status: 'completed' },
      });

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'return_event',
          entityId: returnEventId ?? args.order.id,
          action: 'sale_return.completed',
          beforeAfter: {
            orderId: args.order.id,
            amount: args.refundAmount,
            method: args.refundMethod,
            lines: args.lines,
            refundPaymentId: pay.id,
            status: 'completed',
          },
        },
      });

      await this.accounting.postSaleReturn(tx, user, returnEventId!);

      return { pay, returnEventId: returnEventId! };
    });

    const credit =
      args.refundMethod === PaymentMethod.store_credit && args.order.customerId
        ? await this.prisma.customer.findFirst({
            where: { id: args.order.customerId },
            select: { storeCreditBalance: true },
          })
        : null;

    return {
      orderId: args.order.id,
      orderNumber: args.order.orderNumber,
      returnEventId: outcome.returnEventId,
      refundPaymentId: outcome.pay.id,
      amount: outcome.pay.amount,
      status: 'completed' as const,
      message: '✓ Return Completed',
      storeCreditBalance: credit
        ? Number(credit.storeCreditBalance)
        : null,
      restocked: args.lines.map((l) => ({
        stockLevelId: l.stockLevelId,
        quantity: l.quantity,
        condition: l.condition,
      })),
    };
  }

  private splitReturnItemsJson(itemsJson: unknown): {
    items: Array<Record<string, unknown>>;
    returnedItems: Array<Record<string, unknown>>;
    replacedItems: Array<Record<string, unknown>>;
  } {
    const arr = Array.isArray(itemsJson)
      ? (itemsJson as Array<Record<string, unknown>>)
      : [];
    const hasKind = arr.some((i) => i.kind != null);
    if (!hasKind) {
      return { items: arr, returnedItems: arr, replacedItems: [] };
    }
    return {
      items: arr,
      returnedItems: arr.filter((i) => i.kind !== 'replace'),
      replacedItems: arr.filter((i) => i.kind === 'replace'),
    };
  }

  private async buildReturnItemsJson(
    tenantId: string,
    orderItems: Array<{ stockLevelId: string | null; description: string | null }>,
    returnLines: ReturnLine[],
    replaceLines?: Array<{
      stockLevelId: string;
      quantity: number;
      unitPrice?: number;
    }>,
  ): Promise<Prisma.InputJsonValue> {
    const levelIds = new Set<string>();
    for (const l of returnLines) levelIds.add(l.stockLevelId);
    for (const r of replaceLines ?? []) levelIds.add(r.stockLevelId);

    const levels =
      levelIds.size > 0
        ? await this.prisma.stockLevel.findMany({
            where: { tenantId, id: { in: [...levelIds] } },
            select: {
              id: true,
              sellPrice: true,
              product: { select: { name: true, skuCode: true } },
            },
          })
        : [];

    const byLevel = new Map(
      levels.map((l) => [
        l.id,
        {
          name: l.product.name,
          sku: l.product.skuCode,
          sellPrice: Number(l.sellPrice ?? 0),
        },
      ]),
    );

    const returned = returnLines.map((l) => ({
      kind: 'return',
      stockLevelId: l.stockLevelId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      condition: l.condition,
      refundShare: l.refundShare,
      returnBaseQty: l.returnBaseQty,
      orderedQuantity: l.orderedQuantity,
      orderedUnitSymbol: l.orderedUnitSymbol,
      baseQuantity: l.baseQuantity,
      baseUnitSymbol: l.baseUnitSymbol,
      priceQuantity: l.priceQuantity,
      priceUnitSymbol: l.priceUnitSymbol,
      name:
        orderItems.find((i) => i.stockLevelId === l.stockLevelId)
          ?.description ??
        byLevel.get(l.stockLevelId)?.name ??
        'Item',
      sku: byLevel.get(l.stockLevelId)?.sku ?? null,
    }));

    const replaced = (replaceLines ?? []).map((item) => ({
      kind: 'replace',
      stockLevelId: item.stockLevelId,
      quantity: item.quantity,
      unitPrice:
        item.unitPrice ?? byLevel.get(item.stockLevelId)?.sellPrice ?? 0,
      name: byLevel.get(item.stockLevelId)?.name ?? 'Item',
      sku: byLevel.get(item.stockLevelId)?.sku ?? null,
    }));

    return [...returned, ...replaced] as Prisma.InputJsonValue;
  }
}
