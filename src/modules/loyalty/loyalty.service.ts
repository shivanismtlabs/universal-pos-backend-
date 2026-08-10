import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateCouponDto,
  PatchCouponDto,
  ValidateCouponDto,
} from './dto/loyalty.dto';

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

  /** Call after paid order with coupon code applied */
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
}
