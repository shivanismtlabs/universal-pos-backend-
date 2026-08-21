import { PaymentMethod, PaymentStatus } from '@prisma/client';

export type PaymentProviderId = 'internal' | 'stripe' | 'upi' | 'none';

export type PaymentMethodCapability = {
  method: PaymentMethod;
  displayName: string;
  /** Cash / gift / store credit — collected in-store without a PSP. */
  requiresProvider: boolean;
  requiresConfirmation: boolean;
  supportsRefund: boolean;
  supportsPartialPayment: boolean;
  supportsOffline: boolean;
  supportsSplitPayment: boolean;
  provider: PaymentProviderId;
  primary: boolean;
};

export type PaymentMethodCatalogRow = PaymentMethodCapability & {
  configured: boolean;
  available: boolean;
  reason?: string;
};

const INTERNAL_IMMEDIATE: PaymentMethod[] = [
  PaymentMethod.cash,
  PaymentMethod.gift_card,
  PaymentMethod.store_credit,
  PaymentMethod.qr,
  PaymentMethod.wallet,
];

const STRIPE_METHODS: PaymentMethod[] = [PaymentMethod.card, PaymentMethod.upi];

/** EMI still needs a finance provider; QR/Wallet are cashier-confirmed in-store. */
const UNCONFIGURED_EXTERNAL: PaymentMethod[] = [PaymentMethod.emi];

const CAPABILITIES: Record<PaymentMethod, PaymentMethodCapability> = {
  [PaymentMethod.cash]: {
    method: PaymentMethod.cash,
    displayName: 'Cash',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: true,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: true,
  },
  [PaymentMethod.card]: {
    method: PaymentMethod.card,
    displayName: 'Card',
    requiresProvider: true,
    requiresConfirmation: true,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'stripe',
    primary: true,
  },
  [PaymentMethod.upi]: {
    method: PaymentMethod.upi,
    displayName: 'UPI',
    requiresProvider: true,
    requiresConfirmation: true,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'stripe',
    primary: true,
  },
  [PaymentMethod.gift_card]: {
    method: PaymentMethod.gift_card,
    displayName: 'Gift card',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: false,
    supportsPartialPayment: true,
    supportsOffline: true,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: false,
  },
  [PaymentMethod.store_credit]: {
    method: PaymentMethod.store_credit,
    displayName: 'Store credit',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: false,
    supportsPartialPayment: true,
    supportsOffline: true,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: false,
  },
  [PaymentMethod.bank_transfer]: {
    method: PaymentMethod.bank_transfer,
    displayName: 'Bank transfer',
    requiresProvider: false,
    requiresConfirmation: true,
    supportsRefund: false,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: false,
  },
  [PaymentMethod.qr]: {
    method: PaymentMethod.qr,
    displayName: 'QR',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: true,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: true,
  },
  [PaymentMethod.wallet]: {
    method: PaymentMethod.wallet,
    displayName: 'Wallet',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: true,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: true,
  },
  [PaymentMethod.emi]: {
    method: PaymentMethod.emi,
    displayName: 'EMI',
    requiresProvider: true,
    requiresConfirmation: true,
    supportsRefund: true,
    supportsPartialPayment: false,
    supportsOffline: false,
    supportsSplitPayment: false,
    provider: 'internal',
    primary: false,
  },
  [PaymentMethod.gateway]: {
    method: PaymentMethod.gateway,
    displayName: 'Gateway',
    requiresProvider: true,
    requiresConfirmation: true,
    supportsRefund: true,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'stripe',
    primary: false,
  },
  [PaymentMethod.collect_later]: {
    method: PaymentMethod.collect_later,
    displayName: 'Customer credit',
    requiresProvider: false,
    requiresConfirmation: false,
    supportsRefund: false,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'internal',
    primary: false,
  },
  [PaymentMethod.other]: {
    method: PaymentMethod.other,
    displayName: 'Other',
    requiresProvider: true,
    requiresConfirmation: true,
    supportsRefund: false,
    supportsPartialPayment: true,
    supportsOffline: false,
    supportsSplitPayment: true,
    provider: 'none',
    primary: false,
  },
};

export function getPaymentMethodCapability(
  method: PaymentMethod,
): PaymentMethodCapability {
  return CAPABILITIES[method];
}

export function isInternalImmediate(method: PaymentMethod): boolean {
  return INTERNAL_IMMEDIATE.includes(method);
}

export function isStripeTender(method: PaymentMethod): boolean {
  return STRIPE_METHODS.includes(method);
}

export function stripeKeysEnabled(
  publishableKey?: string | null,
  secretKey?: string | null,
): boolean {
  const pk = publishableKey?.trim() ?? '';
  const sk = secretKey?.trim() ?? '';
  return pk.startsWith('pk_') && sk.startsWith('sk_');
}

export function buildPaymentMethodCatalog(opts: {
  stripeEnabled: boolean;
  upiProviderConfigured?: boolean;
}): PaymentMethodCatalogRow[] {
  const stripeOn = opts.stripeEnabled;

  return (Object.keys(CAPABILITIES) as PaymentMethod[]).map((method) => {
    const cap = CAPABILITIES[method];
    let configured = true;
    let available = true;
    let reason: string | undefined;

    if (isInternalImmediate(method) || method === PaymentMethod.collect_later) {
      configured = true;
      available = true;
    } else if (isStripeTender(method) || method === PaymentMethod.gateway) {
      configured = stripeOn;
      available = stripeOn;
      if (!stripeOn) {
        reason = 'Stripe is not configured';
      }
    } else if (method === PaymentMethod.bank_transfer) {
      configured = true;
      available = true;
      reason = 'Records as pending until finance confirms the transfer';
    } else if (
      method === PaymentMethod.qr ||
      method === PaymentMethod.wallet
    ) {
      configured = true;
      available = true;
    } else if (UNCONFIGURED_EXTERNAL.includes(method)) {
      configured = false;
      available = false;
      reason = `${cap.displayName} provider is not configured`;
    }

    return { ...cap, configured, available, reason };
  });
}

/** Map PSP PaymentIntent-style status onto PaymentStatus. */
export function mapProviderIntentStatus(
  providerStatus: string,
): PaymentStatus {
  switch (providerStatus) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return PaymentStatus.pending;
    case 'processing':
      return PaymentStatus.processing;
    case 'succeeded':
      return PaymentStatus.succeeded;
    case 'canceled':
    case 'cancelled':
      return PaymentStatus.cancelled;
    case 'requires_capture':
      return PaymentStatus.processing;
    default:
      return PaymentStatus.failed;
  }
}

const TERMINAL: PaymentStatus[] = [
  PaymentStatus.succeeded,
  PaymentStatus.failed,
  PaymentStatus.cancelled,
];

export function canTransitionPaymentStatus(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  if (from === to) return true;
  if (TERMINAL.includes(from) && to !== from) {
    // Succeeded may still move to cancelled only via explicit refund rows, not status rewrite
    return false;
  }
  const order: PaymentStatus[] = [
    PaymentStatus.created,
    PaymentStatus.initiated,
    PaymentStatus.pending,
    PaymentStatus.processing,
  ];
  const fromI = order.indexOf(from);
  const toI = order.indexOf(to);
  if (TERMINAL.includes(to)) {
    return fromI >= 0 || from === PaymentStatus.pending;
  }
  if (fromI < 0 || toI < 0) return false;
  return toI >= fromI;
}

export function refundableAmount(
  originalAmount: number,
  alreadyRefundedSucceeded: number,
): number {
  return Math.max(
    0,
    Math.round((originalAmount - alreadyRefundedSucceeded) * 100) / 100,
  );
}
