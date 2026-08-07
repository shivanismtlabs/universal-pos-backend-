import { Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { ensurePlatformCatalog } from '../../common/provision-tenant';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreatePlanDto,
  CreateSubscriptionDto,
} from './dto/platform-billing.dto';

@Injectable()
export class PlatformBillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** FE still reads `priceInr`; schema column is `priceAmount`. */
  private mapPlan<T extends { priceAmount: unknown }>(plan: T) {
    return {
      ...plan,
      priceInr: plan.priceAmount,
    };
  }

  async listPlans() {
    let plans = await this.prisma.plan.findMany({
      orderBy: { priceAmount: 'asc' },
    });
    if (!plans.length) {
      await ensurePlatformCatalog(this.prisma);
      plans = await this.prisma.plan.findMany({
        orderBy: { priceAmount: 'asc' },
      });
    }
    return plans.map((p) => this.mapPlan(p));
  }

  async createPlan(dto: CreatePlanDto) {
    try {
      const plan = await this.prisma.plan.create({
        data: {
          code: dto.code.trim().toLowerCase(),
          name: dto.name.trim(),
          priceAmount: dto.priceMonthly.toFixed(2),
          currencyCode: 'INR',
        },
      });
      return this.mapPlan(plan);
    } catch (e) {
      throwIfUnique(e, 'Plan code already exists');
    }
  }

  async getSubscription(user: AuthUser) {
    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    if (!sub) return null;
    return {
      ...sub,
      plan: this.mapPlan(sub.plan),
    };
  }

  async upsertSubscription(user: AuthUser, dto: CreateSubscriptionDto) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const existing = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const sub = existing
      ? await this.prisma.tenantSubscription.update({
          where: { id: existing.id },
          data: { planId: plan.id, status: SubscriptionStatus.active },
          include: { plan: true },
        })
      : await this.prisma.tenantSubscription.create({
          data: {
            tenantId: user.tenantId,
            planId: plan.id,
            status: SubscriptionStatus.active,
            seatsUsed: 1,
            locationsUsed: 1,
            currentPeriodEnd: new Date(Date.now() + 365 * 86400000),
          },
          include: { plan: true },
        });

    return {
      ...sub,
      plan: this.mapPlan(sub.plan),
    };
  }
}
