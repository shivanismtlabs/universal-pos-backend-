import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { OrdersService } from '../orders/orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AccountingPostingService } from '../accounting/posting.service';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  RefundPaymentDto,
} from './dto/payments.dto';

type PrismaTx = Prisma.TransactionClient;

const NON_PAYABLE: OrderStatus[] = [
  OrderStatus.cancelled,
  OrderStatus.closed,
];

const IMMEDIATE: PaymentMethod[] = [
  PaymentMethod.cash,
  PaymentMethod.card,
  PaymentMethod.upi,
  PaymentMethod.bank_transfer,
  PaymentMethod.wallet,
  PaymentMethod.qr,
  PaymentMethod.emi,
  PaymentMethod.store_credit,
  PaymentMethod.gift_card,
];

const CREDIT: PaymentType[] = [PaymentType.payment, PaymentType.deposit];
const REFUND: PaymentType[] = [
  PaymentType.refund,
  PaymentType.deposit_refund,
];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly loyalty: LoyaltyService,
    private readonly accounting: AccountingPostingService,
  ) {}

  async create(user: AuthUser, dto: CreatePaymentDto) {
    const existing = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: dto.orderId, tenantId: user.tenantId },
        select: { id: true, status: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (NON_PAYABLE.includes(order.status)) {
        throw new BadRequestException(
          `Cannot record payment for a ${order.status} order`,
        );
      }

      const type = dto.type ?? PaymentType.payment;
      const status = IMMEDIATE.includes(dto.method)
        ? PaymentStatus.succeeded
        : PaymentStatus.pending;

      if (
        dto.method === PaymentMethod.store_credit &&
        status === PaymentStatus.succeeded &&
        type === PaymentType.payment
      ) {
        const orderFull = await tx.order.findFirst({
          where: { id: dto.orderId, tenantId: user.tenantId },
          select: { customerId: true },
        });
        if (!orderFull?.customerId) {
          throw new BadRequestException(
            'Store credit pay needs a customer on the order',
          );
        }
        const cust = await tx.customer.findFirst({
          where: { id: orderFull.customerId, tenantId: user.tenantId },
          select: { storeCreditBalance: true },
        });
        const bal = Number(cust?.storeCreditBalance ?? 0);
        if (bal + 1e-9 < dto.amount) {
          throw new BadRequestException(
            `Insufficient store credit (have ${bal.toFixed(2)})`,
          );
        }
        const nextBal = Number((bal - Number(dto.amount.toFixed(2))).toFixed(2));
        await tx.customer.update({
          where: { id: orderFull.customerId },
          data: {
            storeCreditBalance: nextBal.toFixed(2),
          },
        });
        await tx.storeCreditLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            customerId: orderFull.customerId,
            kind: 'debit',
            amount: dto.amount.toFixed(2),
            balanceAfter: nextBal.toFixed(2),
            orderId: dto.orderId,
            note: 'Order payment',
            actorUserId: user.userId,
          },
        });
      }

      if (
        dto.method === PaymentMethod.gift_card &&
        status === PaymentStatus.succeeded &&
        type === PaymentType.payment
      ) {
        if (!dto.gatewayRef?.trim()) {
          throw new BadRequestException(
            'gatewayRef must be the gift card code',
          );
        }
        await this.loyalty.redeemGiftCardInTx(tx, {
          tenantId: user.tenantId,
          code: dto.gatewayRef,
          amount: dto.amount,
          orderId: dto.orderId,
          userId: user.userId,
        });
      }

      let payment;
      try {
        payment = await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: dto.orderId,
            type,
            method: dto.method,
            amount: dto.amount.toFixed(2),
            status,
            gatewayRef: dto.gatewayRef,
            idempotencyKey: dto.idempotencyKey,
            takenByUserId: user.userId,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const winner = await tx.payment.findUnique({
            where: {
              tenantId_idempotencyKey: {
                tenantId: user.tenantId,
                idempotencyKey: dto.idempotencyKey,
              },
            },
          });
          if (winner) return winner;
        }
        throw e;
      }

      if (status === PaymentStatus.succeeded) {
        await this.ordersService.recalculateTotals(
          tx,
          user.tenantId,
          dto.orderId,
        );
        await tx.outboxEvent.create({
          data: {
            tenantId: user.tenantId,
            eventType: 'payment.completed',
            aggregateType: 'payment',
            aggregateId: payment.id,
            payload: { orderId: dto.orderId, amount: dto.amount },
          },
        });
        const existingSale = await tx.journalEntry.findFirst({
          where: {
            tenantId: user.tenantId,
            sourceKey: `SALE:${dto.orderId}`,
          },
          select: { id: true },
        });
        if (existingSale) {
          await this.accounting.postCustomerPayment(tx, user, payment.id);
        } else {
          await this.accounting.postSale(tx, user, dto.orderId);
        }
      }

      return payment;
    });
  }

  async list(user: AuthUser, query: ListPaymentsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where: Prisma.PaymentWhereInput = {
      tenantId: user.tenantId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, meta: pageMeta(total, page, limit) };
  }

  async getById(user: AuthUser, id: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async refund(user: AuthUser, parentId: string, dto: RefundPaymentDto) {
    const existing = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const parent = await tx.payment.findFirst({
        where: { id: parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Payment not found');
      if (
        parent.status !== PaymentStatus.succeeded ||
        !CREDIT.includes(parent.type)
      ) {
        throw new BadRequestException(
          'Only a succeeded payment/deposit can be refunded',
        );
      }

      const already = await tx.payment.aggregate({
        where: {
          tenantId: user.tenantId,
          orderId: parent.orderId,
          status: PaymentStatus.succeeded,
          type: { in: REFUND },
          gatewayPayload: {
            path: ['parentPaymentId'],
            equals: parent.id,
          },
        },
        _sum: { amount: true },
      });
      const refundedSoFar = Number(already._sum.amount ?? 0);
      const refundable = Number(parent.amount) - refundedSoFar;
      if (dto.amount > refundable) {
        throw new BadRequestException(
          `Refund exceeds refundable ${refundable.toFixed(2)}`,
        );
      }

      const refundType =
        parent.type === PaymentType.deposit
          ? PaymentType.deposit_refund
          : PaymentType.refund;

      const refund = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: parent.orderId,
          type: refundType,
          method: parent.method,
          amount: dto.amount.toFixed(2),
          status: PaymentStatus.succeeded,
          gatewayRef: dto.reason,
          gatewayPayload: { parentPaymentId: parent.id },
          idempotencyKey: dto.idempotencyKey,
          takenByUserId: user.userId,
        },
      });

      await this.ordersService.recalculateTotals(
        tx,
        user.tenantId,
        parent.orderId,
      );
      return refund;
    });
  }

  /** Kept for callers that still inject PaymentsService.recalculateBalance */
  async recalculateBalance(tx: PrismaTx, tenantId: string, orderId: string) {
    return this.ordersService.recalculateTotals(tx, tenantId, orderId);
  }
}
