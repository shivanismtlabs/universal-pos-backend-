import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '@prisma/client';
import * as https from 'https';
import Stripe from 'stripe';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PosService } from '../pos/pos.service';
import { PaymentsService } from './payments.service';
import {
  CreateStripeIntentDto,
  VerifyStripePaymentDto,
} from './dto/stripe.dto';
import {
  mapProviderIntentStatus,
  stripeKeysEnabled,
} from './payment-capabilities';
import type {
  PaymentProvider,
  ProviderPaymentResult,
  ProviderRefundResult,
} from './payment-provider';

@Injectable()
export class StripeService implements PaymentProvider {
  readonly id = 'stripe';
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Lazy — PaymentsModule must not import PosModule (circular boot). */
  private pos(): PosService {
    return this.moduleRef.get(PosService, { strict: false });
  }

  getPublicConfig() {
    const publishableKey =
      this.config.get<string>('STRIPE_PUBLISHABLE_KEY')?.trim() ?? '';
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY')?.trim() ?? '';
    const enabled = stripeKeysEnabled(publishableKey, secretKey);
    const webhookSecret =
      this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
    return {
      enabled,
      publishableKey: enabled ? publishableKey : null,
      webhookConfigured: webhookSecret.startsWith('whsec_'),
      mode: publishableKey.includes('test')
        ? 'test'
        : publishableKey.includes('live')
          ? 'live'
          : enabled
            ? 'unknown'
            : 'disabled',
    };
  }

  private getClient(): Stripe {
    const cfg = this.getPublicConfig();
    if (!cfg.enabled) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY (Test mode from dashboard.stripe.com).',
      );
    }
    if (!this.client) {
      const secretKey = this.config.get<string>('STRIPE_SECRET_KEY')!.trim();
      const allowInsecureTls =
        this.config.get<string>('STRIPE_ALLOW_INSECURE_TLS') === 'true' &&
        this.config.get<string>('NODE_ENV') !== 'production';

      if (allowInsecureTls) {
        this.logger.warn(
          'STRIPE_ALLOW_INSECURE_TLS=true — TLS verification disabled for Stripe (local/dev only)',
        );
        this.client = new Stripe(secretKey, {
          httpAgent: new https.Agent({ rejectUnauthorized: false }),
        });
      } else {
        this.client = new Stripe(secretKey);
      }
    }
    return this.client;
  }

  async createPayment(args: {
    amount: number;
    currency: string;
    metadata: Record<string, string>;
    method?: string;
    description?: string;
    receiptEmail?: string;
  }): Promise<ProviderPaymentResult> {
    const amountPaise = Math.round(args.amount * 100);
    const stripe = this.getClient();
    const method = args.method ?? PaymentMethod.card;
    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountPaise,
      currency: (args.currency || 'inr').toLowerCase(),
      metadata: args.metadata,
      description: args.description,
      receipt_email: args.receiptEmail,
    };
    if (method === PaymentMethod.upi) {
      intentParams.payment_method_types = ['upi'];
    } else {
      intentParams.payment_method_types = ['card'];
    }
    const intent = await stripe.paymentIntents.create(intentParams);
    if (!intent.client_secret) {
      throw new BadRequestException('Stripe did not return a client secret');
    }
    return {
      provider: this.id,
      providerPaymentId: intent.id,
      status: intent.status,
      clientSecret: intent.client_secret,
      amount: args.amount,
      currency: intent.currency,
    };
  }

  async getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentResult> {
    const intent = await this.getClient().paymentIntents.retrieve(
      providerPaymentId,
    );
    return {
      provider: this.id,
      providerPaymentId: intent.id,
      status: intent.status,
      clientSecret: intent.client_secret,
      amount: intent.amount / 100,
      currency: intent.currency,
      failureReason: intent.last_payment_error?.message ?? null,
    };
  }

  async cancelPayment(
    providerPaymentId: string,
  ): Promise<ProviderPaymentResult> {
    const intent = await this.getClient().paymentIntents.cancel(
      providerPaymentId,
    );
    return {
      provider: this.id,
      providerPaymentId: intent.id,
      status: intent.status,
      amount: intent.amount / 100,
      currency: intent.currency,
    };
  }

  async refundPayment(args: {
    providerPaymentId: string;
    amount: number;
    reason?: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<ProviderRefundResult> {
    const refund = await this.getClient().refunds.create(
      {
        payment_intent: args.providerPaymentId,
        amount: Math.round(args.amount * 100),
        reason: 'requested_by_customer',
        metadata: args.metadata,
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return {
      provider: this.id,
      providerRefundId: refund.id,
      status: refund.status ?? 'pending',
      amount: (refund.amount ?? 0) / 100,
      failureReason: refund.failure_reason ?? null,
    };
  }

  async createPaymentIntent(user: AuthUser, dto: CreateStripeIntentDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: {
        customer: { select: { fullName: true, phone: true, email: true } },
        location: { select: { name: true } },
      },
    });
    if (!order) {
      throw new BadRequestException('Order not found');
    }
    if (user.locationId && order.locationId !== user.locationId) {
      throw new ForbiddenException('Order is outside your store');
    }

    const method = dto.method ?? PaymentMethod.card;
    if (method !== PaymentMethod.card && method !== PaymentMethod.upi) {
      throw new BadRequestException('Stripe supports card or UPI only');
    }

    const attemptKey = dto.idempotencyKey?.trim();
    if (attemptKey) {
      const existingPay = await this.payments.findByIdempotency(
        user.tenantId,
        attemptKey,
      );
      if (existingPay) {
        if (existingPay.status === PaymentStatus.succeeded) {
          const cfg = this.getPublicConfig();
          return {
            publishableKey: cfg.publishableKey,
            clientSecret: '',
            paymentIntentId: existingPay.gatewayRef ?? '',
            amount: Number(existingPay.amount),
            amountPaise: Math.round(Number(existingPay.amount) * 100),
            currency: 'inr',
            name: order.location.name,
            description: `${order.orderNumber} · already paid`,
            customerName: order.customer?.fullName ?? 'Walk-in',
            replayed: true,
            paymentId: existingPay.id,
            status: existingPay.status,
          };
        }
        if (existingPay.gatewayRef?.startsWith('pi_')) {
          const existing = await this.getPaymentStatus(existingPay.gatewayRef);
          const cfg = this.getPublicConfig();
          return {
            publishableKey: cfg.publishableKey,
            clientSecret: existing.clientSecret,
            paymentIntentId: existing.providerPaymentId,
            amount: Number(existingPay.amount),
            amountPaise: Math.round(Number(existingPay.amount) * 100),
            currency: 'inr',
            name: order.location.name,
            description: `${order.orderNumber} · ${dto.type ?? PaymentType.payment}`,
            customerName: order.customer?.fullName ?? 'Walk-in',
            replayed: true,
            paymentId: existingPay.id,
            status: existingPay.status,
          };
        }
      }
    }

    const balanceDue = Number(order.balanceDue);
    if (balanceDue <= 0.009) {
      throw new BadRequestException('This ticket is already fully paid');
    }
    if (dto.amount > balanceDue + 0.02) {
      throw new BadRequestException(
        `Payment amount exceeds balance due (${balanceDue.toFixed(2)})`,
      );
    }

    const amountPaise = Math.round(dto.amount * 100);
    if (dto.amount < 60) {
      throw new BadRequestException('Minimum Stripe amount is ₹60.00');
    }

    const type = dto.type ?? PaymentType.payment;
    const created = await this.createPayment({
      amount: dto.amount,
      currency: 'inr',
      method,
      description: `${order.orderNumber} · ${type}`,
      receiptEmail: order.customer?.email ?? undefined,
      metadata: {
        walitOrderId: order.id,
        orderNumber: order.orderNumber,
        tenantId: user.tenantId,
        type,
        method,
        actorUserId: user.userId,
        ...(attemptKey ? { attemptKey } : {}),
      },
    });

    const idempotencyKey = attemptKey || `stripe_${created.providerPaymentId}`;
    const payment = await this.payments.create(
      user,
      {
        orderId: dto.orderId,
        amount: dto.amount,
        method,
        type,
        idempotencyKey,
        gatewayRef: created.providerPaymentId,
      },
      {
        provider: 'stripe',
        status: PaymentStatus.initiated,
        gatewayPayload: {
          paymentIntentId: created.providerPaymentId,
        },
      },
    );

    const cfg = this.getPublicConfig();
    return {
      publishableKey: cfg.publishableKey,
      clientSecret: created.clientSecret,
      paymentIntentId: created.providerPaymentId,
      amount: dto.amount,
      amountPaise,
      currency: 'inr',
      name: order.location.name,
      description: `${order.orderNumber} · ${type}`,
      customerName: order.customer?.fullName ?? 'Walk-in',
      paymentId: payment.id,
      status: payment.status,
    };
  }

  async verifyAndRecord(user: AuthUser, dto: VerifyStripePaymentDto) {
    const stripe = this.getClient();
    const intent = await stripe.paymentIntents.retrieve(dto.paymentIntentId);

    const tenantFromMeta = intent.metadata?.tenantId;
    if (tenantFromMeta && tenantFromMeta !== user.tenantId) {
      throw new ForbiddenException('Stripe intent does not belong to this shop');
    }

    const orderId = intent.metadata?.walitOrderId || dto.orderId;
    if (intent.metadata?.walitOrderId && intent.metadata.walitOrderId !== dto.orderId) {
      throw new BadRequestException('Stripe intent does not match this order');
    }

    const expectedPaise = Math.round(dto.amount * 100);
    if (intent.amount !== expectedPaise) {
      throw new BadRequestException('Stripe amount mismatch');
    }

    const method = (intent.metadata?.method as PaymentMethod | undefined) ??
      dto.method ??
      PaymentMethod.card;
    if (method !== PaymentMethod.card && method !== PaymentMethod.upi) {
      throw new BadRequestException('Stripe supports card or UPI only');
    }

    const mapped = mapProviderIntentStatus(intent.status);
    if (mapped !== PaymentStatus.succeeded) {
      await this.payments.applyProviderStatus({
        tenantId: user.tenantId,
        actorUserId: user.userId,
        gatewayRef: intent.id,
        status: mapped,
        failureReason: intent.last_payment_error?.message ?? intent.status,
        amount: dto.amount,
        method,
        orderId,
        idempotencyKey: `stripe_${intent.id}`,
        type: dto.type ?? PaymentType.payment,
        gatewayPayload: { stripeStatus: intent.status },
      });
      throw new BadRequestException(
        `Stripe payment not succeeded (status: ${intent.status})`,
      );
    }

    const payment = await this.payments.applyProviderStatus({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      gatewayRef: intent.id,
      status: PaymentStatus.succeeded,
      amount: intent.amount / 100,
      method,
      orderId,
      idempotencyKey:
        intent.metadata?.attemptKey || `stripe_${intent.id}`,
      type: (intent.metadata?.type as PaymentType | undefined) ?? dto.type,
      gatewayPayload: {
        stripeStatus: intent.status,
        chargeId:
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : intent.latest_charge?.id ?? null,
      },
    });

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      select: { kind: true, meta: true, balanceDue: true },
    });
    const meta = (order?.meta ?? {}) as Record<string, unknown>;
    if (order?.kind === 'sale' && Boolean(meta.awaitingStripePayment)) {
      await this.pos().finalizeStripeSale(user, orderId);
    }

    return {
      payment,
      needsSaleFinalize: false,
      balanceDue: (
        await this.prisma.order.findFirst({
          where: { id: orderId, tenantId: user.tenantId },
          select: { balanceDue: true },
        })
      )?.balanceDue ?? null,
    };
  }

  async refundOrderPayment(user: AuthUser, parentId: string, dto: {
    amount: number;
    idempotencyKey: string;
    reason?: string;
  }) {
    const existing = await this.payments.findByIdempotency(
      user.tenantId,
      dto.idempotencyKey,
    );
    if (existing) return existing;

    const parent = await this.payments.getById(user, parentId);
    if (!parent.gatewayRef?.startsWith('pi_') && parent.provider !== 'stripe') {
      throw new BadRequestException('Not a Stripe payment');
    }
    const piId = parent.gatewayRef!;
    const created = await this.refundPayment({
      providerPaymentId: piId,
      amount: dto.amount,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
      metadata: {
        tenantId: user.tenantId,
        parentPaymentId: parent.id,
        orderId: parent.orderId,
      },
    });

    const refundStatus =
      created.status === 'succeeded'
        ? PaymentStatus.succeeded
        : created.status === 'failed'
          ? PaymentStatus.failed
          : PaymentStatus.processing;

    return this.payments.insertRefundRow(
      user,
      parent,
      dto,
      refundStatus,
      {
        provider: 'stripe',
        gatewayRef: created.providerRefundId,
        gatewayPayload: {
          stripeRefundStatus: created.status,
          paymentIntentId: piId,
        },
      },
    );
  }

  async handleWebhook(rawBody: Buffer | string, signature: string | undefined) {
    const secret =
      this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
    if (!secret.startsWith('whsec_')) {
      throw new ServiceUnavailableException(
        'STRIPE_WEBHOOK_SECRET is not configured',
      );
    }
    if (!signature) {
      throw new UnauthorizedException('Missing Stripe-Signature header');
    }

    let event: Stripe.Event;
    try {
      event = this.getClient().webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      );
    } catch (err) {
      this.logger.warn(
        `Stripe webhook signature failed: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Invalid Stripe webhook signature');
    }

    const recorded = await this.prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (recorded) {
      return { received: true, duplicate: true, eventId: event.id };
    }

    try {
      await this.dispatchWebhookEvent(event);
    } catch (err) {
      this.logger.error(
        `Stripe webhook ${event.type} ${event.id} failed: ${(err as Error).message}`,
      );
      throw err;
    }

    const tenantId = this.tenantIdFromEvent(event);
    await this.prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        tenantId: tenantId ?? null,
        paymentIntentId: this.paymentIntentIdFromEvent(event),
        payload: { type: event.type } as object,
      },
    });

    return { received: true, duplicate: false, eventId: event.id };
  }

  private tenantIdFromEvent(event: Stripe.Event): string | undefined {
    const obj = event.data.object as {
      metadata?: { tenantId?: string };
      payment_intent?: string | { metadata?: { tenantId?: string } };
    };
    if (obj.metadata?.tenantId) return obj.metadata.tenantId;
    return undefined;
  }

  private paymentIntentIdFromEvent(event: Stripe.Event): string | null {
    const obj = event.data.object as {
      id?: string;
      object?: string;
      payment_intent?: string | { id?: string };
    };
    if (obj.object === 'payment_intent' && obj.id) return obj.id;
    if (typeof obj.payment_intent === 'string') return obj.payment_intent;
    if (obj.payment_intent && typeof obj.payment_intent === 'object') {
      return obj.payment_intent.id ?? null;
    }
    return null;
  }

  private async dispatchWebhookEvent(event: Stripe.Event) {
    if (event.type.startsWith('payment_intent.')) {
      const intent = event.data.object as Stripe.PaymentIntent;
      await this.applyIntentEvent(intent);
      return;
    }
    if (event.type === 'charge.refunded' || event.type.startsWith('refund.')) {
      await this.applyRefundEvent(event);
    }
  }

  private async applyIntentEvent(intent: Stripe.PaymentIntent) {
    const tenantId = intent.metadata?.tenantId;
    const orderId = intent.metadata?.walitOrderId;
    const actorUserId = intent.metadata?.actorUserId;
    if (!tenantId || !orderId) {
      this.logger.warn(`Stripe PI ${intent.id} missing tenant/order metadata`);
      return;
    }
    const method = (intent.metadata?.method as PaymentMethod | undefined) ??
      PaymentMethod.card;
    const mapped = mapProviderIntentStatus(intent.status);
    const actor =
      actorUserId ||
      (
        await this.prisma.order.findFirst({
          where: { id: orderId, tenantId },
          select: { createdById: true },
        })
      )?.createdById;
    if (!actor) {
      this.logger.warn(`Stripe PI ${intent.id} has no actor user`);
      return;
    }

    await this.payments.applyProviderStatus({
      tenantId,
      actorUserId: actor,
      gatewayRef: intent.id,
      status: mapped,
      failureReason: intent.last_payment_error?.message ?? null,
      amount: intent.amount / 100,
      method,
      orderId,
      idempotencyKey: intent.metadata?.attemptKey || `stripe_${intent.id}`,
      type: (intent.metadata?.type as PaymentType | undefined) ?? PaymentType.payment,
      gatewayPayload: { stripeStatus: intent.status, source: 'webhook' },
    });

    if (mapped === PaymentStatus.succeeded) {
      const user: AuthUser = {
        userId: actor,
        tenantId,
        email: '',
        roles: ['cashier'],
        fullName: 'webhook',
      };
      await this.pos().finalizeStripeSale(user, orderId);
    }
  }

  private async applyRefundEvent(event: Stripe.Event) {
    const obj = event.data.object as Stripe.Refund | Stripe.Charge;
    const refund =
      obj.object === 'refund'
        ? (obj as Stripe.Refund)
        : (obj as Stripe.Charge).refunds?.data?.[0];
    if (!refund?.id) return;
    const tenantId =
      refund.metadata?.tenantId || this.tenantIdFromEvent(event);
    if (!tenantId) return;

    const status =
      refund.status === 'succeeded'
        ? PaymentStatus.succeeded
        : refund.status === 'failed'
          ? PaymentStatus.failed
          : PaymentStatus.processing;

    const updated = await this.payments.markRefundStatus({
      tenantId,
      gatewayRef: refund.id,
      status,
      failureReason: refund.failure_reason ?? null,
      gatewayPayload: { stripeRefundStatus: refund.status, source: 'webhook' },
    });

    if (!updated && refund.metadata?.parentPaymentId && refund.amount) {
      const parent = await this.prisma.payment.findFirst({
        where: { id: refund.metadata.parentPaymentId, tenantId },
      });
      if (!parent) return;
      const actor =
        parent.takenByUserId ||
        (
          await this.prisma.order.findFirst({
            where: { id: parent.orderId },
            select: { createdById: true },
          })
        )?.createdById;
      if (!actor) return;
      const user: AuthUser = {
        userId: actor,
        tenantId,
        email: '',
        roles: ['cashier'],
        fullName: 'webhook',
      };
      await this.payments.insertRefundRow(
        user,
        parent,
        {
          amount: refund.amount / 100,
          idempotencyKey: `stripe_refund_${refund.id}`,
          reason: refund.reason ?? undefined,
        },
        status,
        {
          provider: 'stripe',
          gatewayRef: refund.id,
        },
      );
    }
  }

  /**
   * Hosted Stripe Checkout for SaaS plan (tenant platform billing).
   */
  async createPlatformPlanCheckout(args: {
    tenantId: string;
    tenantSlug?: string;
    planId: string;
    planCode: string;
    planName: string;
    amountInr: number;
    currencyCode: string;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    if (args.amountInr < 60) {
      throw new BadRequestException('Minimum Stripe amount is ₹60.00');
    }
    const amountPaise = Math.round(args.amountInr * 100);
    const currency = (args.currencyCode || 'inr').toLowerCase();
    const stripe = this.getClient();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: args.customerEmail || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amountPaise,
            product_data: {
              name: `Universal POS — ${args.planName}`,
              description: `Monthly subscription (${args.planCode})`,
            },
          },
        },
      ],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: {
        purpose: 'platform_plan',
        tenantId: args.tenantId,
        planId: args.planId,
        planCode: args.planCode,
        amountInr: String(args.amountInr),
      },
      payment_intent_data: {
        metadata: {
          purpose: 'platform_plan',
          tenantId: args.tenantId,
          planId: args.planId,
        },
      },
    });

    if (!session.url) {
      throw new BadRequestException('Stripe Checkout did not return a URL');
    }

    return {
      sessionId: session.id,
      url: session.url,
      amountInr: args.amountInr,
      currency: currency.toUpperCase(),
    };
  }

  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    const stripe = this.getClient();
    return stripe.checkout.sessions.retrieve(sessionId);
  }
}
