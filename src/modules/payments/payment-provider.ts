/**
 * Provider port — each adapter implements only the operations it supports.
 * The payment engine never assumes every PSP can refund, cancel, or webhook.
 */

export type ProviderPaymentResult = {
  provider: string;
  providerPaymentId: string;
  status: string;
  clientSecret?: string | null;
  amount: number;
  currency: string;
  failureReason?: string | null;
  raw?: Record<string, unknown>;
};

export type ProviderRefundResult = {
  provider: string;
  providerRefundId: string;
  status: string;
  amount: number;
  failureReason?: string | null;
};

export interface PaymentProvider {
  readonly id: string;
  createPayment?(args: {
    amount: number;
    currency: string;
    metadata: Record<string, string>;
    method?: string;
    description?: string;
    receiptEmail?: string;
  }): Promise<ProviderPaymentResult>;
  getPaymentStatus?(providerPaymentId: string): Promise<ProviderPaymentResult>;
  cancelPayment?(providerPaymentId: string): Promise<ProviderPaymentResult>;
  refundPayment?(args: {
    providerPaymentId: string;
    amount: number;
    reason?: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<ProviderRefundResult>;
}
