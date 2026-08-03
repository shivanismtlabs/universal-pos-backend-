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
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  RefundPaymentDto,
} from './dto/payments.dto';

type PrismaTx = Prisma.TransactionClient;

const NON_PAYABLE_STATUSES: OrderStatus[] = [
  OrderStatus.cancelled,
  OrderStatus.closed,
];

const IMMEDIATE_METHODS: PaymentMethod[] = [
  PaymentMethod.cash,
  PaymentMethod.card,
  PaymentMethod.upi,
];

const CREDIT_TYPES: PaymentType[] = [PaymentType.payment, PaymentType.deposit];
const REFUND_TYPES: PaymentType[] = [
  PaymentType.refund,
  PaymentType.deposit_refund,
];

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreatePaymentDto) {
    const existing = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.rentalOrder.findFirst({
        where: { id: dto.orderId, tenantId: user.tenantId },
        select: { id: true, status: true },
      });
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (NON_PAYABLE_STATUSES.includes(order.status)) {
        throw new BadRequestException(
          `Cannot record payment for a ${order.status} order`,
        );
      }

      const type = dto.type ?? PaymentType.payment;
      const isImmediate = IMMEDIATE_METHODS.includes(dto.method);
      const status = isImmediate
        ? PaymentStatus.succeeded
        : PaymentStatus.pending;

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
            takenById: user.userId,
            paidAt: isImmediate ? new Date() : null,
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
        await this.recalculateBalance(tx, user.tenantId, dto.orderId);
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
      include: {
        refunds: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
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
    if (existing) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const parent = await tx.payment.findFirst({
        where: { id: parentId, tenantId: user.tenantId },
      });
      if (!parent) {
        throw new NotFoundException('Payment not found');
      }
      if (
        parent.status !== PaymentStatus.succeeded ||
        !CREDIT_TYPES.includes(parent.type)
      ) {
        throw new BadRequestException(
          'Only a succeeded payment/deposit can be refunded',
        );
      }

      const alreadyRefunded = await tx.payment.aggregate({
        where: {
          tenantId: user.tenantId,
          parentPaymentId: parent.id,
          status: PaymentStatus.succeeded,
          type: { in: REFUND_TYPES },
        },
        _sum: { amount: true },
      });
      const refundedSoFar = Number(alreadyRefunded._sum.amount ?? 0);
      const refundable = Number(parent.amount) - refundedSoFar;

      if (dto.amount > refundable) {
        throw new BadRequestException(
          `Refund amount exceeds refundable balance of ${refundable.toFixed(2)}`,
        );
      }

      const refundType =
        parent.type === PaymentType.deposit
          ? PaymentType.deposit_refund
          : PaymentType.refund;

      let refund;
      try {
        refund = await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: parent.orderId,
            type: refundType,
            parentPaymentId: parent.id,
            method: parent.method,
            amount: dto.amount.toFixed(2),
            status: PaymentStatus.succeeded,
            gatewayRef: dto.reason,
            idempotencyKey: dto.idempotencyKey,
            takenById: user.userId,
            paidAt: new Date(),
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

      await this.recalculateBalance(tx, user.tenantId, parent.orderId);

      return refund;
    });
  }

  /** subtotal + taxTotal + fees - succeeded(payment+deposit) + succeeded(refund+deposit_refund) */
  async recalculateBalance(tx: PrismaTx, tenantId: string, orderId: string) {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, tenantId },
      select: { subtotal: true, taxTotal: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const [fees, credits, refunds] = await Promise.all([
      tx.orderFee.aggregate({
        where: { tenantId, orderId },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({
        where: {
          tenantId,
          orderId,
          status: PaymentStatus.succeeded,
          type: { in: CREDIT_TYPES },
        },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({
        where: {
          tenantId,
          orderId,
          status: PaymentStatus.succeeded,
          type: { in: REFUND_TYPES },
        },
        _sum: { amount: true },
      }),
    ]);

    const balanceDue =
      Number(order.subtotal) +
      Number(order.taxTotal) +
      Number(fees._sum.amount ?? 0) -
      Number(credits._sum.amount ?? 0) +
      Number(refunds._sum.amount ?? 0);

    return tx.rentalOrder.update({
      where: { id: orderId },
      data: { balanceDue: balanceDue.toFixed(2) },
    });
  }
}
