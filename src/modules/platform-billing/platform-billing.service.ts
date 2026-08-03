import { Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
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

  listPlans() {
    return this.prisma.plan.findMany({ orderBy: { priceInr: 'asc' } });
  }

  async createPlan(dto: CreatePlanDto) {
    try {
      return await this.prisma.plan.create({
        data: {
          code: dto.code.trim().toLowerCase(),
          name: dto.name.trim(),
          priceInr: dto.priceMonthly.toFixed(2),
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Plan code already exists');
    }
  }

  getSubscription(user: AuthUser) {
    return this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
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

    if (existing) {
      return this.prisma.tenantSubscription.update({
        where: { id: existing.id },
        data: { planId: plan.id, status: SubscriptionStatus.active },
        include: { plan: true },
      });
    }

    return this.prisma.tenantSubscription.create({
      data: {
        tenantId: user.tenantId,
        planId: plan.id,
        status: SubscriptionStatus.active,
      },
      include: { plan: true },
    });
  }
}
