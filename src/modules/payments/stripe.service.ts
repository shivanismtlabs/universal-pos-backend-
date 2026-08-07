import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentType } from '@prisma/client';
import * as https from 'https';
import Stripe from 'stripe';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from './payments.service';
import {
  CreateStripeIntentDto,
  VerifyStripePaymentDto,
} from './dto/stripe.dto';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  getPublicConfig() {
    const publishableKey =
      this.config.get<string>('STRIPE_PUBLISHABLE_KEY')?.trim() ?? '';
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY')?.trim() ?? '';
    const enabled = Boolean(
      publishableKey.startsWith('pk_') && secretKey.startsWith('sk_'),
    );
    return {
      enabled,
      publishableKey: enabled ? publishableKey : null,
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
      // Local only: antivirus / proxy SSL inspection breaks Node's cert chain.
      // Never enable in production.
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

    // INR uses paise (2 decimals). Stripe also enforces ~USD/EUR 0.50 minimum
    // after FX — ₹50 often fails, so require ₹60+.
    const amountPaise = Math.round(dto.amount * 100);
    if (dto.amount < 60) {
      throw new BadRequestException('Minimum Stripe amount is ₹60.00');
    }

    const method = dto.method ?? PaymentMethod.card;
    const type = dto.type ?? PaymentType.payment;
    const stripe = this.getClient();

    // Card-only for card checkouts — automatic_payment_methods enables Link /
    // wallets which often return generic "A processing error occurred" on
    // confirm in INR test mode. UPI intents stay UPI-only.
    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountPaise,
      currency: 'inr',
      metadata: {
        walitOrderId: order.id,
        orderNumber: order.orderNumber,
        tenantId: user.tenantId,
        type,
        method,
      },
      description: `${order.orderNumber} · ${type}`,
      receipt_email: order.customer?.email ?? undefined,
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

    const cfg = this.getPublicConfig();
    return {
      publishableKey: cfg.publishableKey,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amount: dto.amount,
      amountPaise,
      currency: 'inr',
      name: order.location.name,
      description: `${order.orderNumber} · ${type}`,
      customerName: order.customer?.fullName ?? 'Walk-in',
    };
  }

  async verifyAndRecord(user: AuthUser, dto: VerifyStripePaymentDto) {
    const stripe = this.getClient();
    const intent = await stripe.paymentIntents.retrieve(dto.paymentIntentId);

    if (intent.status !== 'succeeded') {
      throw new BadRequestException(
        `Stripe payment not succeeded (status: ${intent.status})`,
      );
    }

    const expectedPaise = Math.round(dto.amount * 100);
    if (intent.amount !== expectedPaise) {
      throw new BadRequestException('Stripe amount mismatch');
    }

    if (
      intent.metadata?.walitOrderId &&
      intent.metadata.walitOrderId !== dto.orderId
    ) {
      throw new BadRequestException('Stripe intent does not match this order');
    }

    const method = dto.method ?? PaymentMethod.card;
    if (method !== PaymentMethod.card && method !== PaymentMethod.upi) {
      throw new BadRequestException('Stripe supports card or UPI only');
    }

    return this.payments.create(user, {
      orderId: dto.orderId,
      amount: dto.amount,
      method,
      type: dto.type ?? PaymentType.payment,
      idempotencyKey: `stripe_${dto.paymentIntentId}`,
      gatewayRef: dto.paymentIntentId,
    }).then(async (payment) => {
      const order = await this.prisma.order.findFirst({
        where: { id: dto.orderId, tenantId: user.tenantId },
        select: { kind: true, meta: true, balanceDue: true },
      });
      const meta = (order?.meta ?? {}) as Record<string, unknown>;
      return {
        payment,
        needsSaleFinalize:
          order?.kind === 'sale' && Boolean(meta.awaitingStripePayment),
        balanceDue: order?.balanceDue ?? null,
      };
    });
  }
}
