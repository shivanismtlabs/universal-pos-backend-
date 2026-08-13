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
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { PaymentsService } from '../payments/payments.service';
import type { SaleExchangeDto, SaleReturnDto } from './dto/pos.dto';

function money(n: Prisma.Decimal | string | number) {
  return new Prisma.Decimal(n);
}

@Injectable()
export class SaleReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly loyalty: LoyaltyService,
  ) {}

  async saleReturn(user: AuthUser, dto: SaleReturnDto) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.closed,
      },
      include: {
        items: true,
        customer: { select: { id: true, storeCreditBalance: true } },
      },
    });
    if (!order) throw new NotFoundException('Closed sale not found');

    if (
      dto.refundMethod === PaymentMethod.store_credit &&
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
        refundPaymentId: existingPay.id,
        replayed: true,
        status: 'completed' as const,
      };
    }

    const existingEvent = await this.prisma.returnEvent.findFirst({
      where: { tenantId: user.tenantId, idempotencyKey: dto.idempotencyKey },
    });
    if (existingEvent) {
      return {
        orderId: order.id,
        returnEventId: existingEvent.id,
        status: existingEvent.status,
        replayed: true,
        amount: existingEvent.refundAmount
          ? Number(existingEvent.refundAmount)
          : null,
      };
    }

    if (dto.reasonCode) {
      const reason = await this.prisma.refundReason.findFirst({
        where: {
          tenantId: user.tenantId,
          code: dto.reasonCode,
          isActive: true,
        },
      });
      if (!reason) {
        throw new BadRequestException(
          `Unknown refund reason: ${dto.reasonCode}`,
        );
      }
    }

    const alreadyReturned = await this.returnedQtyByLevel(
      user.tenantId,
      order.id,
    );

    let refundCalc = money(0);
    const lines: Array<{
      stockLevelId: string;
      quantity: number;
      unitPrice: number;
    }> = [];

    for (const ret of dto.items) {
      const sold = order.items.filter(
        (i) =>
          i.stockLevelId === ret.stockLevelId &&
          i.itemKind === OrderItemKind.product,
      );
      if (!sold.length) {
        throw new BadRequestException(
          `Item ${ret.stockLevelId} was not on this sale`,
        );
      }
      const soldQty = sold.reduce((s, i) => s + Number(i.quantity), 0);
      const prior = alreadyReturned.get(ret.stockLevelId) ?? 0;
      const remaining = Math.max(0, soldQty - prior);
      if (ret.quantity > remaining + 1e-9) {
        throw new BadRequestException(
          `Cannot return ${ret.quantity} (remaining ${remaining})`,
        );
      }
      const unitPrice = Number(sold[0].unitPrice);
      refundCalc = refundCalc.add(money(unitPrice).mul(ret.quantity));
      lines.push({
        stockLevelId: ret.stockLevelId,
        quantity: ret.quantity,
        unitPrice,
      });
    }

    const refundAmount =
      dto.amount !== undefined ? money(dto.amount) : refundCalc;
    if (refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount must be > 0');
    }

    const notes =
      dto.reason?.trim() ||
      (dto.reasonCode
        ? `Reason: ${dto.reasonCode}`
        : `Sale return: ${lines.map((l) => `${l.quantity}×${l.stockLevelId.slice(0, 8)}`).join(', ')}`);

    if (!this.isRefundApprover(user)) {
      const pending = await this.prisma.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          receivedById: user.userId,
          notes,
          status: 'pending',
          reasonCode: dto.reasonCode,
          refundAmount: refundAmount.toFixed(2),
          refundMethod: dto.refundMethod,
          itemsJson: lines,
          idempotencyKey: dto.idempotencyKey,
        },
      });
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        returnEventId: pending.id,
        status: 'pending' as const,
        amount: Number(refundAmount.toFixed(2)),
        message: 'Return submitted for approval',
        restocked: [] as Array<{ stockLevelId: string; quantity: number }>,
        storeCreditBalance: null as number | null,
        refundPaymentId: null as string | null,
      };
    }

    return this.completeSaleReturn(user, {
      order,
      lines,
      refundAmount: Number(refundAmount.toFixed(2)),
      refundMethod: dto.refundMethod,
      notes,
      reasonCode: dto.reasonCode,
      idempotencyKey: dto.idempotencyKey,
      approvedById: user.userId,
    });
  }

  listSaleReturns(user: AuthUser, status?: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.returnEvent
      .findMany({
        where: {
          tenantId: user.tenantId,
          stockUnitId: null,
          ...(status && status !== 'all' ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              customer: { select: { fullName: true, phone: true } },
            },
          },
          receivedBy: { select: { fullName: true } },
          approvedBy: { select: { fullName: true } },
        },
      })
      .then((rows) => ({
        items: rows.map((r) => ({
          id: r.id,
          status: r.status,
          reasonCode: r.reasonCode,
          notes: r.notes,
          refundAmount:
            r.refundAmount != null ? Number(r.refundAmount) : null,
          refundMethod: r.refundMethod,
          items: r.itemsJson,
          orderId: r.orderId,
          orderNumber: r.order.orderNumber,
          customerName: r.order.customer?.fullName ?? null,
          receivedBy: r.receivedBy?.fullName ?? null,
          approvedBy: r.approvedBy?.fullName ?? null,
          rejectReason: r.rejectReason,
          createdAt: r.createdAt,
        })),
      }));
  }

  async returnedQuantities(user: AuthUser, orderId: string) {
    const map = await this.returnedQtyByLevel(user.tenantId, orderId);
    return {
      orderId,
      byStockLevelId: Object.fromEntries(map.entries()),
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
        status: 'pending',
      },
    });
    if (!ev) throw new NotFoundException('Pending return not found');

    const order = await this.prisma.order.findFirst({
      where: {
        id: ev.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.closed,
      },
      include: {
        items: true,
        customer: { select: { id: true, storeCreditBalance: true } },
      },
    });
    if (!order) throw new NotFoundException('Closed sale not found');

    const rawLines = Array.isArray(ev.itemsJson)
      ? (ev.itemsJson as Array<{
          stockLevelId: string;
          quantity: number;
          unitPrice: number;
        }>)
      : [];
    if (!rawLines.length) {
      throw new BadRequestException('Return has no line items');
    }

    return this.completeSaleReturn(user, {
      order,
      lines: rawLines,
      refundAmount: Number(ev.refundAmount ?? 0),
      refundMethod: (ev.refundMethod ||
        PaymentMethod.cash) as PaymentMethod,
      notes: ev.notes || 'Approved sale return',
      reasonCode: ev.reasonCode ?? undefined,
      idempotencyKey: ev.idempotencyKey || `approve-return-${ev.id}`,
      approvedById: user.userId,
      existingEventId: ev.id,
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
        status: 'pending',
      },
    });
    if (!ev) throw new NotFoundException('Pending return not found');
    await this.prisma.returnEvent.update({
      where: { id: ev.id },
      data: {
        status: 'rejected',
        approvedById: user.userId,
        rejectReason: reason?.trim() || 'Rejected',
      },
    });
    return { id: ev.id, status: 'rejected' };
  }

  listRefundReasons(user: AuthUser) {
    return this.prisma.refundReason.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  createRefundReason(
    user: AuthUser,
    dto: { code: string; label: string; sortOrder?: number },
  ) {
    return this.prisma.refundReason.create({
      data: {
        tenantId: user.tenantId,
        code: dto.code.trim().toLowerCase().replace(/\s+/g, '_'),
        label: dto.label.trim(),
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async seedRefundReasons(user: AuthUser) {
    const defaults = [
      { code: 'damaged', label: 'Damaged / defective', sortOrder: 1 },
      { code: 'wrong_item', label: 'Wrong item', sortOrder: 2 },
      {
        code: 'customer_changed_mind',
        label: 'Customer changed mind',
        sortOrder: 3,
      },
      { code: 'quality', label: 'Quality issue', sortOrder: 4 },
      { code: 'exchange', label: 'Exchange', sortOrder: 5 },
      { code: 'other', label: 'Other', sortOrder: 99 },
    ];
    for (const d of defaults) {
      await this.prisma.refundReason.upsert({
        where: {
          tenantId_code: { tenantId: user.tenantId, code: d.code },
        },
        create: { tenantId: user.tenantId, ...d },
        update: { label: d.label, isActive: true, sortOrder: d.sortOrder },
      });
    }
    return this.listRefundReasons(user);
  }

  /**
   * Exchange = completed return (store credit) + replacement chargeSale paid from credit/settle.
   */
  async saleExchange(user: AuthUser, dto: SaleExchangeDto) {
    if (!this.isRefundApprover(user)) {
      throw new BadRequestException(
        'Exchanges require manager / admin / accountant',
      );
    }

    const ret = await this.saleReturn(user, {
      orderId: dto.orderId,
      items: dto.returnItems,
      refundMethod: PaymentMethod.store_credit,
      reasonCode: dto.reasonCode || 'exchange',
      reason: dto.reason || 'Product exchange',
      idempotencyKey: `${dto.idempotencyKey}:return`,
    });

    if (ret.status === 'pending') {
      throw new BadRequestException(
        'Exchange requires immediate approval rights',
      );
    }

    const returnAmount = Number(ret.amount ?? 0);
    let replaceTotal = 0;
    const levels = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        id: { in: dto.replaceItems.map((i) => i.stockLevelId) },
      },
      include: {
        product: { select: { id: true, name: true } },
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
      const price = item.unitPrice ?? Number(level.sellPrice ?? 0);
      replaceTotal += price * item.quantity;
    }
    replaceTotal = Math.round(replaceTotal * 100) / 100;
    const net = Math.round((replaceTotal - returnAmount) * 100) / 100;

    const original = await this.prisma.order.findFirstOrThrow({
      where: { id: dto.orderId, tenantId: user.tenantId },
      select: {
        locationId: true,
        customerId: true,
        orderNumber: true,
      },
    });

    // Build replacement order manually for net settle control
    const orderNumber = `EX-${Date.now().toString(36).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId: original.locationId,
          customerId: original.customerId,
          orderNumber,
          kind: OrderKind.sale,
          status: OrderStatus.confirmed,
          createdById: user.userId,
          meta: {
            exchangeOfOrderId: dto.orderId,
            exchangeOfOrderNumber: original.orderNumber,
          },
        },
      });

      for (const item of dto.replaceItems) {
        const level = levelMap.get(item.stockLevelId)!;
        const price = item.unitPrice ?? Number(level.sellPrice ?? 0);
        if (Number(level.qtyOnHand) < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for ${level.product.name}`,
          );
        }
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { decrement: item.quantity } },
        });
        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            itemKind: OrderItemKind.product,
            productId: level.product.id,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: item.quantity,
            unitPrice: price.toFixed(2),
            lineTotal: (price * item.quantity).toFixed(2),
          },
        });
      }

      await this.recalcOrderTotals(tx, user.tenantId, order.id);

      const dueRow = await tx.order.findFirstOrThrow({
        where: { id: order.id },
        select: { balanceDue: true },
      });
      const due = Number(dueRow.balanceDue);

      // Apply store credit from return first
      let remaining = due;
      if (
        returnAmount > 0 &&
        original.customerId &&
        remaining > 0
      ) {
        const apply = Math.min(returnAmount, remaining);
        const cust = await tx.customer.findFirst({
          where: { id: original.customerId },
          select: { storeCreditBalance: true },
        });
        const bal = Number(cust?.storeCreditBalance ?? 0);
        const use = Math.min(bal, apply);
        if (use > 0) {
          const nextBal = Number((bal - use).toFixed(2));
          await tx.customer.update({
            where: { id: original.customerId },
            data: { storeCreditBalance: nextBal.toFixed(2) },
          });
          await tx.storeCreditLedgerEntry.create({
            data: {
              tenantId: user.tenantId,
              customerId: original.customerId,
              kind: 'debit',
              amount: use.toFixed(2),
              balanceAfter: nextBal.toFixed(2),
              orderId: order.id,
              note: 'Applied to exchange replacement',
              actorUserId: user.userId,
            },
          });
          await tx.payment.create({
            data: {
              tenantId: user.tenantId,
              orderId: order.id,
              type: PaymentType.payment,
              method: PaymentMethod.store_credit,
              amount: use.toFixed(2),
              status: PaymentStatus.succeeded,
              idempotencyKey: `${dto.idempotencyKey}:credit-apply`,
              takenByUserId: user.userId,
            },
          });
          remaining = Number((remaining - use).toFixed(2));
        }
      }

      if (remaining > 0.009) {
        await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            type: PaymentType.payment,
            method: dto.settleMethod,
            amount: remaining.toFixed(2),
            status: PaymentStatus.succeeded,
            idempotencyKey: `${dto.idempotencyKey}:settle`,
            takenByUserId: user.userId,
          },
        });
        remaining = 0;
      } else if (net < -0.009 && original.customerId) {
        // Extra credit already on wallet from return — leave it
      }

      await this.paymentsService.recalculateBalance(
        tx,
        user.tenantId,
        order.id,
      );
      const final = await tx.order.findFirstOrThrow({
        where: { id: order.id },
        select: { balanceDue: true },
      });
      if (money(final.balanceDue).lte(0)) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.fulfilled },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.closed },
        });
      }

      return {
        orderId: order.id,
        orderNumber,
        replaceTotal,
        returnAmount,
        net,
        balanceDue: Number(final.balanceDue),
      };
    });

    return {
      return: ret,
      replacement: created,
      message: 'Exchange completed',
    };
  }

  private isRefundApprover(user: AuthUser) {
    return user.roles.some(
      (r) => r === 'admin' || r === 'manager' || r === 'accountant',
    );
  }

  private async returnedQtyByLevel(tenantId: string, orderId: string) {
    const events = await this.prisma.returnEvent.findMany({
      where: {
        tenantId,
        orderId,
        status: { in: ['pending', 'completed', 'approved'] },
        stockUnitId: null,
      },
      select: { itemsJson: true },
    });
    const map = new Map<string, number>();
    for (const ev of events) {
      const lines = Array.isArray(ev.itemsJson)
        ? (ev.itemsJson as Array<{ stockLevelId?: string; quantity?: number }>)
        : [];
      for (const l of lines) {
        if (!l.stockLevelId || !l.quantity) continue;
        map.set(
          l.stockLevelId,
          (map.get(l.stockLevelId) ?? 0) + Number(l.quantity),
        );
      }
    }
    return map;
  }

  private async completeSaleReturn(
    user: AuthUser,
    args: {
      order: {
        id: string;
        orderNumber: string;
        customerId: string | null;
      };
      lines: Array<{
        stockLevelId: string;
        quantity: number;
        unitPrice: number;
      }>;
      refundAmount: number;
      refundMethod: PaymentMethod;
      notes: string;
      reasonCode?: string;
      idempotencyKey: string;
      approvedById: string;
      existingEventId?: string;
    },
  ) {
    if (args.refundAmount <= 0) {
      throw new BadRequestException('Refund amount must be > 0');
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      for (const line of args.lines) {
        await tx.stockLevel.update({
          where: { id: line.stockLevelId },
          data: { qtyOnHand: { increment: line.quantity } },
        });
      }

      if (args.existingEventId) {
        await tx.returnEvent.update({
          where: { id: args.existingEventId },
          data: {
            status: 'completed',
            approvedById: args.approvedById,
            notes: args.notes,
          },
        });
      } else {
        await tx.returnEvent.create({
          data: {
            tenantId: user.tenantId,
            orderId: args.order.id,
            receivedById: user.userId,
            approvedById: args.approvedById,
            notes: args.notes,
            status: 'completed',
            reasonCode: args.reasonCode,
            refundAmount: args.refundAmount.toFixed(2),
            refundMethod: args.refundMethod,
            itemsJson: args.lines,
            idempotencyKey: args.idempotencyKey,
          },
        });
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
      return pay;
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
      returnEventId: args.existingEventId ?? null,
      refundPaymentId: payment.id,
      amount: payment.amount,
      status: 'completed' as const,
      storeCreditBalance: credit
        ? Number(credit.storeCreditBalance)
        : null,
      restocked: args.lines.map((l) => ({
        stockLevelId: l.stockLevelId,
        quantity: l.quantity,
      })),
      message: undefined as string | undefined,
    };
  }

  private async recalcOrderTotals(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const items = await tx.orderItem.findMany({
      where: { orderId, tenantId },
      select: { quantity: true, unitPrice: true },
    });
    const subtotal = items.reduce(
      (s, i) => s + Number(i.quantity) * Number(i.unitPrice),
      0,
    );
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: subtotal.toFixed(2),
        taxTotal: '0',
        discountTotal: '0',
        balanceDue: subtotal.toFixed(2),
      },
    });
  }
}
