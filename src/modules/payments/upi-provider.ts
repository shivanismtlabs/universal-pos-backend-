import { BadRequestException } from '@nestjs/common';
import type { PaymentProvider, ProviderPaymentResult } from './payment-provider';

/**
 * Dedicated UPI/QR PSP adapter.
 * Stripe UPI is handled by StripeService when Stripe is configured.
 * This adapter exists so the engine can report NOT CONFIGURED instead of faking success.
 */
export class UpiProvider implements PaymentProvider {
  readonly id = 'upi';

  async createPayment(): Promise<ProviderPaymentResult> {
    throw new BadRequestException(
      'UPI provider is not configured. Configure Stripe UPI or a merchant UPI PSP.',
    );
  }

  async getPaymentStatus(): Promise<ProviderPaymentResult> {
    throw new BadRequestException('UPI provider is not configured');
  }
}
