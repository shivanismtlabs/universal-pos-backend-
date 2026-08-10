import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { ensurePlatformCatalog } from '../../common/provision-tenant';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { StripeService } from '../payments/stripe.service';
import {
  CreatePlanCheckoutDto,
  CreatePlanDto,
  CreateSubscriptionDto,
  ConfirmPlanCheckoutDto,
} from './dto/platform-billing.dto';

@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /** FE still reads `priceInr`; schema column is `priceAmount`. */
  private mapPlan<T extends { priceAmount: unknown }>(plan: T) {
    return {
      ...plan,
      priceInr: plan.priceAmount,
    };
  }

  private planAmountInr(plan: { priceAmount: unknown }): number {
    const n = Number(plan.priceAmount ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private periodEnd(months = 1) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d;
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
      stripeEnabled: this.stripe.getPublicConfig().enabled,
    };
  }

  /**
   * Free-only activate (₹0). Paid plans must go through Stripe Checkout.
   */
  async upsertSubscription(user: AuthUser, dto: CreateSubscriptionDto) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const amount = this.planAmountInr(plan);
    if (amount > 0) {
      throw new BadRequestException(
        'Paid plans require Stripe Checkout. Use POST /platform-billing/checkout',
      );
    }

    return this.activatePlan(user, plan.id, {
      via: 'free',
      amount: 0,
    });
  }

  /**
   * Start Stripe Checkout for a paid plan upgrade / purchase.
   * Returns `url` to redirect the browser to Stripe Hosted Checkout.
   */
  async createCheckout(user: AuthUser, dto: CreatePlanCheckoutDto) {
    this.assertHttpUrl(dto.successUrl);
    this.assertHttpUrl(dto.cancelUrl);

    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const amount = this.planAmountInr(plan);
    if (amount <= 0) {
      const sub = await this.activatePlan(user, plan.id, {
        via: 'free',
        amount: 0,
      });
      return {
        free: true as const,
        sessionId: null,
        url: null,
        subscription: sub,
      };
    }

    const current = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId, status: SubscriptionStatus.active },
      orderBy: { createdAt: 'desc' },
    });
    if (current?.planId === plan.id) {
      throw new BadRequestException('You are already on this plan');
    }

    const account = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      select: { email: true },
    });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { slug: true },
    });

    // Ensure success URL carries session_id placeholder for Stripe
    const successUrl = dto.successUrl.includes('{CHECKOUT_SESSION_ID}')
      ? dto.successUrl
      : `${dto.successUrl}${dto.successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;

    const session = await this.stripe.createPlatformPlanCheckout({
      tenantId: user.tenantId,
      tenantSlug: tenant?.slug,
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      amountInr: amount,
      currencyCode: plan.currencyCode || 'INR',
      customerEmail: account?.email ?? user.email,
      successUrl,
      cancelUrl: dto.cancelUrl,
    });

    return {
      free: false as const,
      ...session,
    };
  }

  /**
   * After Stripe redirects back, verify paid session and activate plan.
   * Idempotent for the same session.
   */
  async confirmCheckout(user: AuthUser, dto: ConfirmPlanCheckoutDto) {
    const session = await this.stripe.retrieveCheckoutSession(dto.sessionId);

    if (session.metadata?.purpose !== 'platform_plan') {
      throw new BadRequestException('Not a platform plan checkout session');
    }
    if (session.metadata.tenantId !== user.tenantId) {
      throw new BadRequestException('Checkout session does not belong to this shop');
    }
    if (session.payment_status !== 'paid') {
      throw new BadRequestException(
        `Payment not completed (status: ${session.payment_status})`,
      );
    }

    const planId = session.metadata.planId;
    if (!planId) {
      throw new BadRequestException('Checkout session missing plan');
    }

    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const amountPaid =
      typeof session.amount_total === 'number'
        ? session.amount_total / 100
        : this.planAmountInr(plan);

    // Idempotent: already activated for this session (session id lives in JSON, not entityId)
    const recentPays = await this.prisma.auditLog.findMany({
      where: {
        tenantId: user.tenantId,
        action: 'platform.billing.paid',
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { beforeAfter: true },
    });
    const alreadyPaid = recentPays.some((row) => {
      const p = (row.beforeAfter ?? {}) as Record<string, unknown>;
      return p.stripeSessionId === session.id;
    });
    if (alreadyPaid) {
      const sub = await this.getSubscription(user);
      return { alreadyApplied: true as const, subscription: sub };
    }

    const sub = await this.activatePlan(user, plan.id, {
      via: 'stripe_checkout',
      amount: amountPaid,
      stripeSessionId: session.id,
      stripePaymentIntent:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id,
    });

    return { alreadyApplied: false as const, subscription: sub };
  }

  async listInvoices(user: AuthUser) {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId: user.tenantId,
        action: 'platform.billing.paid',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return logs.map((row) => {
      const payload = (row.beforeAfter ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        sessionId: (payload.stripeSessionId as string | null) ?? null,
        createdAt: row.createdAt,
        planCode: payload.planCode ?? null,
        planName: payload.planName ?? null,
        amount: payload.amount ?? null,
        currency: payload.currency ?? 'INR',
        via: payload.via ?? 'stripe',
      };
    });
  }

  async cancelSubscription(user: AuthUser) {
    const existing = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) {
      throw new NotFoundException('No subscription found');
    }
    const sub = await this.prisma.tenantSubscription.update({
      where: { id: existing.id },
      data: { status: SubscriptionStatus.cancelled },
      include: { plan: true },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant_subscription',
        entityId: sub.id,
        action: 'platform.billing.cancelled',
        beforeAfter: { planId: sub.planId },
      },
    });
    return { ...sub, plan: this.mapPlan(sub.plan) };
  }

  private assertHttpUrl(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Invalid return URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Return URL must be http(s)');
    }
  }

  private async activatePlan(
    user: AuthUser,
    planId: string,
    pay: {
      via: string;
      amount: number;
      stripeSessionId?: string;
      stripePaymentIntent?: string | null;
    },
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const existing = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const sub = existing
      ? await this.prisma.tenantSubscription.update({
          where: { id: existing.id },
          data: {
            planId: plan.id,
            status: SubscriptionStatus.active,
            currentPeriodEnd: this.periodEnd(1),
          },
          include: { plan: true },
        })
      : await this.prisma.tenantSubscription.create({
          data: {
            tenantId: user.tenantId,
            planId: plan.id,
            status: SubscriptionStatus.active,
            seatsUsed: 1,
            locationsUsed: 1,
            currentPeriodEnd: this.periodEnd(1),
          },
          include: { plan: true },
        });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant_subscription',
        entityId: sub.id,
        action: 'platform.billing.paid',
        beforeAfter: {
          via: pay.via,
          planId: plan.id,
          planCode: plan.code,
          planName: plan.name,
          amount: pay.amount,
          currency: plan.currencyCode || 'INR',
          stripeSessionId: pay.stripeSessionId ?? null,
          stripePaymentIntent: pay.stripePaymentIntent ?? null,
          subscriptionId: sub.id,
        },
      },
    });

    return {
      ...sub,
      plan: this.mapPlan(sub.plan),
    };
  }
}
