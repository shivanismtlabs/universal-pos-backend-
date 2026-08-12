import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateCouponDto,
  IssueGiftCardDto,
  PatchCouponDto,
  PatchGiftCardDto,
  PatchLoyaltySettingsDto,
  QuoteLoyaltyRedeemDto,
  ValidateCouponDto,
} from './dto/loyalty.dto';

export type LoyaltySettings = {
  enabled: boolean;
  /** Points earned per 1 currency unit of successful payment */
  earnPerCurrency: number;
  /** Currency value when redeeming 1 point */
  currencyPerPoint: number;
};

const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: true,
  earnPerCurrency: 1,
  currencyPerPoint: 0.01,
};

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

@Injectable()
export class LoyaltyService {
  constructor(private readonly prisma: PrismaService) {}

  listCoupons(user: AuthUser) {
    return this.prisma.coupon.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  createCoupon(user: AuthUser, dto: CreateCouponDto) {
    const code = dto.code.trim().toUpperCase();
    if (dto.discountType === 'percent' && dto.discountValue > 100) {
      throw new BadRequestException('Percent discount cannot exceed 100');
    }
    return this.prisma.coupon.create({
      data: {
        tenantId: user.tenantId,
        code,
        description: dto.description?.trim(),
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        minOrderAmount: dto.minOrderAmount,
        maxRedemptions: dto.maxRedemptions,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        isActive: true,
      },
    });
  }

  async patchCoupon(user: AuthUser, id: string, dto: PatchCouponDto) {
    const row = await this.prisma.coupon.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Coupon not found');
    return this.prisma.coupon.update({
      where: { id },
      data: {
        isActive: dto.isActive,
        description: dto.description?.trim(),
      },
    });
  }

  async validate(user: AuthUser, dto: ValidateCouponDto) {
    const code = dto.code.trim().toUpperCase();
    const coupon = await this.prisma.coupon.findFirst({
      where: { tenantId: user.tenantId, code },
    });
    if (!coupon || !coupon.isActive) {
      throw new BadRequestException('Invalid or inactive coupon');
    }
    const now = new Date();
    if (coupon.startsAt && coupon.startsAt > now) {
      throw new BadRequestException('Coupon not active yet');
    }
    if (coupon.endsAt && coupon.endsAt < now) {
      throw new BadRequestException('Coupon expired');
    }
    if (
      coupon.maxRedemptions != null &&
      coupon.redemptionCount >= coupon.maxRedemptions
    ) {
      throw new BadRequestException('Coupon redemption limit reached');
    }
    const min = coupon.minOrderAmount ? Number(coupon.minOrderAmount) : 0;
    if (dto.orderSubtotal < min) {
      throw new BadRequestException(
        `Minimum order amount is ${min.toFixed(2)}`,
      );
    }

    let amountOff = 0;
    if (coupon.discountType === 'percent') {
      amountOff = (dto.orderSubtotal * Number(coupon.discountValue)) / 100;
    } else {
      amountOff = Number(coupon.discountValue);
    }
    amountOff = Math.min(amountOff, dto.orderSubtotal);
    amountOff = Math.round(amountOff * 100) / 100;

    return {
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      amountOff,
    };
  }

  async recordRedemption(
    user: AuthUser,
    args: {
      couponId: string;
      orderId?: string;
      customerId?: string;
      amountOff: number;
    },
  ) {
    await this.prisma.$transaction([
      this.prisma.couponRedemption.create({
        data: {
          tenantId: user.tenantId,
          couponId: args.couponId,
          orderId: args.orderId,
          customerId: args.customerId,
          amountOff: args.amountOff,
        },
      }),
      this.prisma.coupon.update({
        where: { id: args.couponId },
        data: { redemptionCount: { increment: 1 } },
      }),
    ]);
  }

  // ─── Loyalty points ───────────────────────────────────────────────────────

  async getLoyaltySettings(user: AuthUser): Promise<LoyaltySettings> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    return this.parseLoyaltySettings(tenant?.settings);
  }

  parseLoyaltySettings(settings: unknown): LoyaltySettings {
    const root =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>)
        : {};
    const loyalty =
      root.loyalty && typeof root.loyalty === 'object'
        ? (root.loyalty as Record<string, unknown>)
        : {};
    return {
      enabled:
        typeof loyalty.enabled === 'boolean'
          ? loyalty.enabled
          : DEFAULT_LOYALTY.enabled,
      earnPerCurrency:
        typeof loyalty.earnPerCurrency === 'number'
          ? loyalty.earnPerCurrency
          : DEFAULT_LOYALTY.earnPerCurrency,
      currencyPerPoint:
        typeof loyalty.currencyPerPoint === 'number'
          ? loyalty.currencyPerPoint
          : DEFAULT_LOYALTY.currencyPerPoint,
    };
  }

  async patchLoyaltySettings(user: AuthUser, dto: PatchLoyaltySettingsDto) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const root =
      tenant.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const prev = this.parseLoyaltySettings(tenant.settings);
    const next: LoyaltySettings = {
      enabled: dto.enabled ?? prev.enabled,
      earnPerCurrency: dto.earnPerCurrency ?? prev.earnPerCurrency,
      currencyPerPoint: dto.currencyPerPoint ?? prev.currencyPerPoint,
    };
    root.loyalty = next;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });
    return next;
  }

  async quoteRedeem(user: AuthUser, dto: QuoteLoyaltyRedeemDto) {
    const settings = await this.getLoyaltySettings(user);
    if (!settings.enabled) {
      throw new BadRequestException('Loyalty points are disabled');
    }
    const customer = await this.prisma.customer.findFirst({
      where: {
        id: dto.customerId,
        tenantId: user.tenantId,
        deletedAt: null,
      },
      select: { id: true, loyaltyPoints: true, fullName: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (dto.points > customer.loyaltyPoints) {
      throw new BadRequestException(
        `Only ${customer.loyaltyPoints} points available`,
      );
    }
    let amount = Math.round(dto.points * settings.currencyPerPoint * 100) / 100;
    if (dto.maxAmount != null) {
      amount = Math.min(amount, dto.maxAmount);
    }
    const pointsUsed =
      settings.currencyPerPoint > 0
        ? Math.min(
            dto.points,
            Math.ceil(amount / settings.currencyPerPoint - 1e-9),
          )
        : 0;
    return {
      customerId: customer.id,
      pointsAvailable: customer.loyaltyPoints,
      points: pointsUsed,
      amountOff: amount,
      currencyPerPoint: settings.currencyPerPoint,
    };
  }

  /** Redeem points inside an existing prisma transaction */
  async redeemPointsInTx(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      customerId: string;
      points: number;
      orderId?: string;
      settings: LoyaltySettings;
    },
  ) {
    if (args.points <= 0) return { amountOff: 0, points: 0 };
    const cust = await tx.customer.findFirst({
      where: { id: args.customerId, tenantId: args.tenantId },
      select: { loyaltyPoints: true },
    });
    if (!cust || cust.loyaltyPoints < args.points) {
      throw new BadRequestException('Insufficient loyalty points');
    }
    const amountOff =
      Math.round(args.points * args.settings.currencyPerPoint * 100) / 100;
    const balanceAfter = cust.loyaltyPoints - args.points;
    await tx.customer.update({
      where: { id: args.customerId },
      data: { loyaltyPoints: balanceAfter },
    });
    await tx.loyaltyLedgerEntry.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: 'redeem',
        points: -args.points,
        balanceAfter,
        orderId: args.orderId,
        note: `Redeemed ${args.points} pts → ${amountOff.toFixed(2)}`,
      },
    });
    return { amountOff, points: args.points };
  }

  async earnPointsInTx(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      customerId: string;
      paidAmount: number;
      orderId?: string;
      settings: LoyaltySettings;
    },
  ) {
    if (!args.settings.enabled || args.paidAmount <= 0) return { points: 0 };
    const points = Math.floor(args.paidAmount * args.settings.earnPerCurrency);
    if (points <= 0) return { points: 0 };
    const cust = await tx.customer.findFirst({
      where: { id: args.customerId, tenantId: args.tenantId },
      select: { loyaltyPoints: true },
    });
    if (!cust) return { points: 0 };
    const balanceAfter = cust.loyaltyPoints + points;
    await tx.customer.update({
      where: { id: args.customerId },
      data: { loyaltyPoints: balanceAfter },
    });
    await tx.loyaltyLedgerEntry.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: 'earn',
        points,
        balanceAfter,
        orderId: args.orderId,
        note: `Earned on payment ${args.paidAmount.toFixed(2)}`,
      },
    });
    return { points };
  }

  // ─── Gift cards ───────────────────────────────────────────────────────────

  listGiftCards(user: AuthUser) {
    return this.prisma.giftCard.findMany({
      where: { tenantId: user.tenantId },
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async issueGiftCard(user: AuthUser, dto: IssueGiftCardDto) {
    const code = (
      dto.code?.trim() ||
      `GC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    ).toUpperCase();
    if (dto.customerId) {
      const c = await this.prisma.customer.findFirst({
        where: {
          id: dto.customerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!c) throw new NotFoundException('Customer not found');
    }
    const value = money(dto.initialValue).toFixed(2);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const card = await tx.giftCard.create({
          data: {
            tenantId: user.tenantId,
            code,
            initialValue: value,
            balance: value,
            customerId: dto.customerId,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
            note: dto.note?.trim(),
            status: 'active',
          },
        });
        await tx.giftCardTxn.create({
          data: {
            tenantId: user.tenantId,
            giftCardId: card.id,
            kind: 'issue',
            amount: value,
            balanceAfter: value,
            createdById: user.userId,
            note: 'Issued',
          },
        });
        return card;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('Gift card code already exists');
      }
      throw e;
    }
  }

  async lookupGiftCard(user: AuthUser, code: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: {
        tenantId: user.tenantId,
        code: code.trim().toUpperCase(),
      },
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
      },
    });
    if (!card) throw new NotFoundException('Gift card not found');
    return card;
  }

  async patchGiftCard(user: AuthUser, id: string, dto: PatchGiftCardDto) {
    const card = await this.prisma.giftCard.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!card) throw new NotFoundException('Gift card not found');
    return this.prisma.giftCard.update({
      where: { id },
      data: {
        status: dto.status,
        note: dto.note?.trim(),
      },
    });
  }

  /** Debit gift card inside checkout transaction */
  async redeemGiftCardInTx(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      code: string;
      amount: number;
      orderId?: string;
      userId?: string;
    },
  ) {
    const card = await tx.giftCard.findFirst({
      where: {
        tenantId: args.tenantId,
        code: args.code.trim().toUpperCase(),
      },
    });
    if (!card) throw new BadRequestException('Gift card not found');
    if (card.status !== 'active') {
      throw new BadRequestException('Gift card is not active');
    }
    if (card.expiresAt && card.expiresAt < new Date()) {
      throw new BadRequestException('Gift card expired');
    }
    const bal = Number(card.balance);
    if (bal + 1e-9 < args.amount) {
      throw new BadRequestException(
        `Gift card balance ${bal.toFixed(2)} is less than ${args.amount.toFixed(2)}`,
      );
    }
    const next = money(bal).minus(args.amount);
    const depleted = next.lte(0);
    await tx.giftCard.update({
      where: { id: card.id },
      data: {
        balance: next.toFixed(2),
        status: depleted ? 'depleted' : 'active',
      },
    });
    await tx.giftCardTxn.create({
      data: {
        tenantId: args.tenantId,
        giftCardId: card.id,
        kind: 'redeem',
        amount: money(args.amount).neg().toFixed(2),
        balanceAfter: next.toFixed(2),
        orderId: args.orderId,
        createdById: args.userId,
        note: `Redeemed on order`,
      },
    });
    return { giftCardId: card.id, balanceAfter: Number(next.toFixed(2)) };
  }
}
