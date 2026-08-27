import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderKind,
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
import {
  buildPaymentMethodCatalog,
  getPaymentMethodCapability,
  isInternalImmediate,
  isStripeTender,
  refundableAmount,
  stripeKeysEnabled,
} from './payment-capabilities';

type PrismaTx = Prisma.TransactionClient;

const NON_PAYABLE: OrderStatus[] = [
  OrderStatus.cancelled,
  OrderStatus.closed,
];

const CREDIT: PaymentType[] = [PaymentType.payment, PaymentType.deposit];
const REFUND: PaymentType[] = [
  PaymentType.refund,
  PaymentType.deposit_refund,
];

export type RecordPaymentOpts = {
  /** Backend has verified the PSP (Stripe retrieve / webhook). */
  providerConfirmed?: boolean;
  provider?: string;
  status?: PaymentStatus;
  failureReason?: string | null;
  gatewayPayload?: Record<string, unknown>;
  /** Allow a failed/cancelled row even when the order is already settled. */
  allowFailedRecord?: boolean;
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly loyalty: LoyaltyService,
    private readonly accounting: AccountingPostingService,
  ) {}

  isStripeEnabled() {
    return stripeKeysEnabled(
      process.env.STRIPE_PUBLISHABLE_KEY,
      process.env.STRIPE_SECRET_KEY,
    );
  }

  listMethods() {
    return {
      items: buildPaymentMethodCatalog({
        stripeEnabled: this.isStripeEnabled(),
        upiProviderConfigured: this.isStripeEnabled(),
      }),
    };
  }

  async create(user: AuthUser, dto: CreatePaymentDto, opts?: RecordPaymentOpts) {
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
        select: {
          id: true,
          status: true,
          kind: true,
          locationId: true,
          customerId: true,
          balanceDue: true,
        },
      });
      if (!order) throw new NotFoundException('Order not found');
      this.assertLocationScope(user, order.locationId);

      const type = dto.type ?? PaymentType.payment;
      const cap = getPaymentMethodCapability(dto.method);
      const status = this.resolveCreateStatus(dto.method, type, opts);

      if (!opts?.allowFailedRecord && NON_PAYABLE.includes(order.status)) {
        throw new BadRequestException(
          order.status === OrderStatus.closed
            ? 'This ticket is already fully paid'
            : `Cannot record payment for a ${order.status} order`,
        );
      }

      if (
        CREDIT.includes(type) &&
        status === PaymentStatus.succeeded &&
        !opts?.allowFailedRecord
      ) {
        const due = Number(order.balanceDue);
        if (due <= 0.009) {
          throw new BadRequestException('This ticket is already fully paid');
        }
        if (dto.amount > due + 0.02) {
          if (dto.method === PaymentMethod.cash) {
            dto.amount = Math.round(due * 100) / 100;
          } else {
            throw new BadRequestException(
              `Payment amount exceeds balance due (${due.toFixed(2)})`,
            );
          }
        }
      }

      if (
        cap.requiresProvider &&
        CREDIT.includes(type) &&
        status === PaymentStatus.succeeded &&
        !opts?.providerConfirmed
      ) {
        throw new BadRequestException(
          `${cap.displayName} requires provider confirmation — do not mark succeeded from Charge`,
        );
      }

      if (
        cap.requiresProvider &&
        !opts?.providerConfirmed &&
        status !== PaymentStatus.failed &&
        status !== PaymentStatus.cancelled &&
        status !== PaymentStatus.pending &&
        status !== PaymentStatus.initiated &&
        status !== PaymentStatus.processing
      ) {
        throw new BadRequestException(
          `${cap.displayName} is not an immediate tender`,
        );
      }

      if (
        !opts?.providerConfirmed &&
        !opts?.status &&
        !isInternalImmediate(dto.method) &&
        dto.method !== PaymentMethod.bank_transfer &&
        dto.method !== PaymentMethod.collect_later
      ) {
        throw new BadRequestException(
          `${cap.displayName} cannot be marked collected from Charge — use the provider payment flow or leave it unconfigured`,
        );
      }

      const register = await this.resolveRegister(
        tx,
        user,
        order.locationId,
        dto.method,
        status,
        type,
        order.kind,
      );

      if (
        dto.method === PaymentMethod.store_credit &&
        status === PaymentStatus.succeeded &&
        type === PaymentType.payment
      ) {
        await this.debitStoreCredit(tx, user, order, dto.amount);
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
            locationId: order.locationId,
            registerSessionId: register?.id ?? null,
            type,
            method: dto.method,
            amount: dto.amount.toFixed(2),
            status,
            provider:
              opts?.provider ??
              (isStripeTender(dto.method) ? 'stripe' : cap.provider),
            gatewayRef: dto.gatewayRef,
            gatewayPayload: opts?.gatewayPayload
              ? (opts.gatewayPayload as Prisma.InputJsonValue)
              : undefined,
            failureReason: opts?.failureReason ?? null,
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
        await this.afterSucceededPayment(tx, user, payment.id, dto.orderId);
      }

      return payment;
    });
  }

  async list(user: AuthUser, query: ListPaymentsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where: Prisma.PaymentWhereInput = {
      tenantId: user.tenantId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(user.locationId ? { locationId: user.locationId } : {}),
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
      where: {
        id,
        tenantId: user.tenantId,
        ...(user.locationId ? { locationId: user.locationId } : {}),
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async confirmBankTransfer(user: AuthUser, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, tenantId: user.tenantId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.assertLocationScope(user, payment.locationId);
    if (payment.method !== PaymentMethod.bank_transfer) {
      throw new BadRequestException('Only bank transfers can be confirmed here');
    }
    if (payment.status === PaymentStatus.succeeded) return payment;
    if (
      payment.status !== PaymentStatus.pending &&
      payment.status !== PaymentStatus.initiated
    ) {
      throw new BadRequestException(
        `Cannot confirm a ${payment.status} bank transfer`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.succeeded },
      });
      await this.afterSucceededPayment(tx, user, updated.id, updated.orderId);
      return updated;
    });
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

    const parent = await this.prisma.payment.findFirst({
      where: { id: parentId, tenantId: user.tenantId },
    });
    if (!parent) throw new NotFoundException('Payment not found');
    this.assertLocationScope(user, parent.locationId);
    if (
      parent.status !== PaymentStatus.succeeded ||
      !CREDIT.includes(parent.type)
    ) {
      throw new BadRequestException(
        'Only a succeeded payment/deposit can be refunded',
      );
    }

    const already = await this.prisma.payment.aggregate({
      where: {
        tenantId: user.tenantId,
        orderId: parent.orderId,
        status: {
          in: [PaymentStatus.succeeded, PaymentStatus.processing],
        },
        type: { in: REFUND },
        OR: [
          { parentPaymentId: parent.id },
          {
            gatewayPayload: {
              path: ['parentPaymentId'],
              equals: parent.id,
            },
          },
        ],
      },
      _sum: { amount: true },
    });
    const refundedSoFar = Number(already._sum.amount ?? 0);
    const refundable = refundableAmount(Number(parent.amount), refundedSoFar);
    if (dto.amount > refundable) {
      throw new BadRequestException(
        `Refund exceeds refundable ${refundable.toFixed(2)}`,
      );
    }

    const cap = getPaymentMethodCapability(parent.method);
    const stripeRef =
      parent.gatewayRef?.startsWith('pi_') || parent.provider === 'stripe';

    if (isStripeTender(parent.method) || stripeRef) {
      throw new BadRequestException(
        'Refund this payment through Stripe (POST /payments/:id/refund routes to the provider)',
      );
    }

    if (cap.requiresProvider && !isInternalImmediate(parent.method)) {
      throw new BadRequestException(
        `${cap.displayName} refunds require a configured provider`,
      );
    }

    return this.insertRefundRow(user, parent, dto, PaymentStatus.succeeded);
  }

  async insertRefundRow(
    user: AuthUser,
    parent: {
      id: string;
      orderId: string;
      locationId: string | null;
      registerSessionId: string | null;
      type: PaymentType;
      method: PaymentMethod;
      amount: Prisma.Decimal | string | number;
    },
    dto: RefundPaymentDto,
    status: PaymentStatus,
    extra?: {
      provider?: string;
      gatewayRef?: string;
      gatewayPayload?: Record<string, unknown>;
    },
  ) {
    const refundType =
      parent.type === PaymentType.deposit
        ? PaymentType.deposit_refund
        : PaymentType.refund;

    const register =
      parent.method === PaymentMethod.cash
        ? await this.prisma.registerSession.findFirst({
            where: {
              tenantId: user.tenantId,
              locationId: parent.locationId ?? undefined,
              closedAt: null,
            },
          })
        : null;

    try {
      const refund = await this.prisma.$transaction(async (tx) => {
        const row = await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: parent.orderId,
            locationId: parent.locationId,
            registerSessionId: register?.id ?? parent.registerSessionId,
            type: refundType,
            method: parent.method,
            amount: dto.amount.toFixed(2),
            status,
            provider: extra?.provider ?? (parent.method === PaymentMethod.cash ? 'internal' : null),
            gatewayRef: extra?.gatewayRef ?? dto.reason ?? null,
            gatewayPayload: {
              parentPaymentId: parent.id,
              reason: dto.reason ?? null,
              ...(extra?.gatewayPayload ?? {}),
            } as Prisma.InputJsonValue,
            parentPaymentId: parent.id,
            idempotencyKey: dto.idempotencyKey,
            takenByUserId: user.userId,
          },
        });
        if (status === PaymentStatus.succeeded) {
          await this.ordersService.recalculateTotals(
            tx,
            user.tenantId,
            parent.orderId,
          );
        }
        return row;
      });
      return refund;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.payment.findUnique({
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
  }

  async markRefundStatus(args: {
    tenantId: string;
    refundId?: string;
    gatewayRef?: string;
    status: PaymentStatus;
    failureReason?: string | null;
    gatewayPayload?: Record<string, unknown>;
  }) {
    const row = args.refundId
      ? await this.prisma.payment.findFirst({
          where: { id: args.refundId, tenantId: args.tenantId },
        })
      : args.gatewayRef
        ? await this.prisma.payment.findFirst({
            where: { tenantId: args.tenantId, gatewayRef: args.gatewayRef },
          })
        : null;
    if (!row) return null;
    if (row.status === args.status) return row;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: row.id },
        data: {
          status: args.status,
          failureReason: args.failureReason ?? row.failureReason,
          gatewayPayload: args.gatewayPayload
            ? (args.gatewayPayload as Prisma.InputJsonValue)
            : undefined,
        },
      });
      await this.ordersService.recalculateTotals(
        tx,
        args.tenantId,
        updated.orderId,
      );
      return updated;
    });
  }

  /** Kept for callers that still inject PaymentsService.recalculateBalance */
  async recalculateBalance(tx: PrismaTx, tenantId: string, orderId: string) {
    return this.ordersService.recalculateTotals(tx, tenantId, orderId);
  }

  async findByGatewayRef(tenantId: string, gatewayRef: string) {
    return this.prisma.payment.findFirst({
      where: { tenantId, gatewayRef },
    });
  }

  async findByIdempotency(tenantId: string, idempotencyKey: string) {
    return this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId, idempotencyKey },
      },
    });
  }

  async applyProviderStatus(args: {
    tenantId: string;
    actorUserId: string;
    paymentId?: string;
    gatewayRef: string;
    status: PaymentStatus;
    failureReason?: string | null;
    gatewayPayload?: Record<string, unknown>;
    amount?: number;
    method?: PaymentMethod;
    orderId?: string;
    idempotencyKey?: string;
    type?: PaymentType;
  }) {
    const existing =
      (args.paymentId
        ? await this.prisma.payment.findFirst({
            where: { id: args.paymentId, tenantId: args.tenantId },
          })
        : null) ??
      (await this.prisma.payment.findFirst({
        where: { tenantId: args.tenantId, gatewayRef: args.gatewayRef },
      })) ??
      (args.idempotencyKey
        ? await this.prisma.payment.findUnique({
            where: {
              tenantId_idempotencyKey: {
                tenantId: args.tenantId,
                idempotencyKey: args.idempotencyKey,
              },
            },
          })
        : null);

    if (existing) {
      if (existing.status === args.status) return existing;
      if (
        existing.status === PaymentStatus.succeeded &&
        args.status !== PaymentStatus.succeeded
      ) {
        return existing;
      }
      const user: AuthUser = {
        userId: args.actorUserId,
        tenantId: args.tenantId,
        email: '',
        roles: ['cashier'],
        fullName: 'system',
      };
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
          where: { id: existing.id },
          data: {
            status: args.status,
            failureReason: args.failureReason ?? null,
            gatewayRef: args.gatewayRef,
            gatewayPayload: args.gatewayPayload
              ? (args.gatewayPayload as Prisma.InputJsonValue)
              : undefined,
          },
        });
        if (args.status === PaymentStatus.succeeded) {
          await this.afterSucceededPayment(
            tx,
            user,
            updated.id,
            updated.orderId,
          );
        } else {
          await this.ordersService.recalculateTotals(
            tx,
            args.tenantId,
            updated.orderId,
          );
        }
        return updated;
      });
    }

    if (!args.orderId || args.amount == null || !args.method) {
      return null;
    }

    const user: AuthUser = {
      userId: args.actorUserId,
      tenantId: args.tenantId,
      email: '',
      roles: ['cashier'],
      fullName: 'system',
    };
    return this.create(
      user,
      {
        orderId: args.orderId,
        amount: args.amount,
        method: args.method,
        type: args.type ?? PaymentType.payment,
        idempotencyKey: args.idempotencyKey ?? `stripe_${args.gatewayRef}`,
        gatewayRef: args.gatewayRef,
      },
      {
        providerConfirmed: args.status === PaymentStatus.succeeded,
        provider: 'stripe',
        status: args.status,
        failureReason: args.failureReason,
        gatewayPayload: args.gatewayPayload,
        allowFailedRecord: args.status !== PaymentStatus.succeeded,
      },
    );
  }

  private resolveCreateStatus(
    method: PaymentMethod,
    type: PaymentType,
    opts?: RecordPaymentOpts,
  ): PaymentStatus {
    if (opts?.status) return opts.status;
    if (REFUND.includes(type)) {
      return PaymentStatus.pending;
    }
    if (method === PaymentMethod.collect_later) {
      return PaymentStatus.pending;
    }
    if (method === PaymentMethod.bank_transfer) {
      return PaymentStatus.pending;
    }
    if (isInternalImmediate(method)) {
      return PaymentStatus.succeeded;
    }
    if (opts?.providerConfirmed) {
      return PaymentStatus.succeeded;
    }
    return PaymentStatus.pending;
  }

  private async debitStoreCredit(
    tx: PrismaTx,
    user: AuthUser,
    order: { id: string; customerId: string | null },
    amount: number,
  ) {
    if (!order.customerId) {
      throw new BadRequestException(
        'Store credit pay needs a customer on the order',
      );
    }
    const cust = await tx.customer.findFirst({
      where: { id: order.customerId, tenantId: user.tenantId },
      select: { storeCreditBalance: true },
    });
    const bal = Number(cust?.storeCreditBalance ?? 0);
    if (bal + 1e-9 < amount) {
      throw new BadRequestException(
        `Insufficient store credit (have ${bal.toFixed(2)})`,
      );
    }
    const nextBal = Number((bal - Number(amount.toFixed(2))).toFixed(2));
    await tx.customer.update({
      where: { id: order.customerId },
      data: { storeCreditBalance: nextBal.toFixed(2) },
    });
    await tx.storeCreditLedgerEntry.create({
      data: {
        tenantId: user.tenantId,
        customerId: order.customerId,
        kind: 'debit',
        amount: amount.toFixed(2),
        balanceAfter: nextBal.toFixed(2),
        orderId: order.id,
        note: 'Order payment',
        actorUserId: user.userId,
      },
    });
  }

  private async afterSucceededPayment(
    tx: PrismaTx,
    user: AuthUser,
    paymentId: string,
    orderId: string,
  ) {
    await this.ordersService.recalculateTotals(tx, user.tenantId, orderId);
    await tx.outboxEvent.create({
      data: {
        tenantId: user.tenantId,
        eventType: 'payment.completed',
        aggregateType: 'payment',
        aggregateId: paymentId,
        payload: { orderId },
      },
    });
    const existingSale = await tx.journalEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        sourceKey: `SALE:${orderId}`,
      },
      select: { id: true },
    });
    if (existingSale) {
      await this.accounting.postCustomerPayment(tx, user, paymentId);
    } else {
      await this.accounting.postSale(tx, user, orderId);
    }
  }

  private async resolveRegister(
    tx: PrismaTx,
    user: AuthUser,
    locationId: string,
    method: PaymentMethod,
    status: PaymentStatus,
    _type: PaymentType,
    _orderKind: OrderKind,
  ) {
    const cashMovement =
      method === PaymentMethod.cash &&
      (status === PaymentStatus.succeeded ||
        status === PaymentStatus.processing);
    if (!cashMovement) return null;

    const open = await tx.registerSession.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId,
        closedAt: null,
      },
      orderBy: { openedAt: 'desc' },
    });
    if (open) return open;

    // Auto-open so cash checkout never blocks on “open the register first”.
    return tx.registerSession.create({
      data: {
        tenantId: user.tenantId,
        locationId,
        openedById: user.userId,
        openingFloat: '0.00',
      },
    });
  }

  private assertLocationScope(user: AuthUser, locationId: string | null) {
    if (user.locationId && locationId && user.locationId !== locationId) {
      throw new ForbiddenException('Payment is outside your store');
    }
  }
}
