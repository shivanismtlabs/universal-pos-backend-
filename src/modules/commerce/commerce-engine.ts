import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderKind } from '@prisma/client';
import { isCommerceMode } from '../../common/commerce-schema';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PosService } from '../pos/pos.service';
import { RentalPosService } from '../pos/rental-pos.service';

export type CommerceLineInput = {
  mode: string;
  /** Mode-specific payload (sale: stockLevelId+qty; rental: unitId; service: productId…) */
  payload: Record<string, unknown>;
};

export type ModeHandler = {
  /** Validate + resolve stock / bookable resource for one line */
  resolveStock: (
    user: AuthUser,
    line: CommerceLineInput,
    tx: unknown,
  ) => Promise<{ unitPrice: number; description: string; meta?: Record<string, unknown> }>;
  /** Build order-line create data after resolve */
  buildLine: (
    resolved: Awaited<ReturnType<ModeHandler['resolveStock']>>,
    line: CommerceLineInput,
  ) => Record<string, unknown>;
  /** Commit side effects after order row exists (decrement qty, checkout unit…) */
  commit: (
    user: AuthUser,
    orderId: string,
    line: CommerceLineInput,
    resolved: Awaited<ReturnType<ModeHandler['resolveStock']>>,
  ) => Promise<void>;
};

/**
 * Registry of fulfillment-mode handlers.
 * Add a mode = registerMode(code, handlers) — not a new Pos*Service class.
 */
@Injectable()
export class CommerceEngine {
  private readonly handlers = new Map<string, ModeHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly salePos: PosService,
    private readonly rentalPos: RentalPosService,
  ) {
    this.registerBuiltins();
  }

  registerMode(code: string, handler: ModeHandler) {
    if (!isCommerceMode(code)) {
      throw new Error(`Cannot register unknown commerce mode: ${code}`);
    }
    this.handlers.set(code, handler);
  }

  getHandler(code: string): ModeHandler | undefined {
    return this.handlers.get(code);
  }

  listRegistered(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Derive Order.kind from which modes appear in the cart.
   * Any combination of registered modes → single mode or mixed.
   */
  deriveOrderKind(modes: string[]): OrderKind {
    const unique = [...new Set(modes.filter(Boolean))];
    if (unique.length === 0) {
      throw new BadRequestException('Cart has no commerce modes');
    }
    if (unique.length > 1) return OrderKind.mixed;
    const only = unique[0];
    if (only === 'sale') return OrderKind.sale;
    if (only === 'rental') return OrderKind.rental;
    if (only === 'service') return OrderKind.service;
    // subscription and future modes land as mixed until OrderKind grows
    return OrderKind.mixed;
  }

  /**
   * Unified checkout entry — today delegates per-mode to existing POS services
   * until each handler's resolve/build/commit is fully inlined.
   */
  async checkout(
    user: AuthUser,
    input: {
      locationId: string;
      customerId?: string;
      lines: CommerceLineInput[];
      payments: Array<{
        method: string;
        amount: number;
        type?: string;
        idempotencyKey: string;
      }>;
      cashTendered?: number;
      note?: string;
      discountAmount?: number;
    },
  ) {
    if (!input.lines?.length) {
      throw new BadRequestException('Cart is empty');
    }
    for (const line of input.lines) {
      if (!this.handlers.has(line.mode)) {
        throw new BadRequestException(
          `No checkout handler registered for mode "${line.mode}"`,
        );
      }
    }

    const modes = input.lines.map((l) => l.mode);
    const kind = this.deriveOrderKind(modes);

    // Homogeneous sale carts: reuse battle-tested sale checkout.
    if (kind === OrderKind.sale) {
      return this.salePos.saleCheckout(user, {
        locationId: input.locationId,
        customerId: input.customerId,
        items: input.lines.map((l) => ({
          stockLevelId: String(l.payload.stockLevelId),
          quantity: Number(l.payload.quantity ?? 1),
          unitPrice:
            l.payload.unitPrice != null
              ? Number(l.payload.unitPrice)
              : undefined,
        })),
        payments: input.payments.map((p) => ({
          method: p.method as
            | 'cash'
            | 'card'
            | 'upi'
            | 'bank_transfer'
            | 'other',
          amount: p.amount,
          idempotencyKey: p.idempotencyKey,
          type: (p.type as
            | 'payment'
            | 'refund'
            | 'deposit'
            | 'deposit_refund') ?? 'payment',
        })),
        cashTendered: input.cashTendered,
        note: input.note,
        discountAmount: input.discountAmount,
      });
    }

    if (kind === OrderKind.rental) {
      throw new BadRequestException(
        'Use rental POS checkout for rental-only carts (session + /pos/checkout). Mixed-cart path is next.',
      );
    }

    throw new BadRequestException(
      `Unified checkout for kind "${kind}" is registered but not fully wired yet. Modes: ${modes.join(', ')}`,
    );
  }

  private registerBuiltins() {
    // Sale adapter — stock resolution lives in PosService; placeholder hooks keep the registry shape.
    this.registerMode('sale', {
      resolveStock: async () => {
        throw new BadRequestException(
          'sale.resolveStock is invoked via PosService.saleCheckout today',
        );
      },
      buildLine: () => ({}),
      commit: async () => undefined,
    });

    this.registerMode('rental', {
      resolveStock: async () => {
        throw new BadRequestException(
          'rental.resolveStock is invoked via RentalPosService today',
        );
      },
      buildLine: () => ({}),
      commit: async () => undefined,
    });

    this.registerMode('service', {
      resolveStock: async (_user, line) => {
        const productId = String(line.payload.productId ?? '');
        if (!productId) {
          throw new BadRequestException('service line requires productId');
        }
        const product = await this.prisma.product.findFirst({
          where: {
            id: productId,
            tenantId: _user.tenantId,
            fulfillmentMode: 'service',
            isActive: true,
          },
        });
        if (!product) {
          throw new BadRequestException('Service product not found');
        }
        return {
          unitPrice: Number(product.basePrice),
          description: product.name,
          meta: { productId: product.id },
        };
      },
      buildLine: (resolved) => ({
        itemKind: 'service',
        description: resolved.description,
        unitPrice: resolved.unitPrice,
        quantity: 1,
        lineTotal: resolved.unitPrice,
        productId: resolved.meta?.productId,
      }),
      commit: async () => {
        /* booking link / appointment mark — Phase next */
      },
    });

    this.registerMode('subscription', {
      resolveStock: async (_user, line) => {
        const productId = String(line.payload.productId ?? '');
        if (!productId) {
          throw new BadRequestException('subscription line requires productId');
        }
        const product = await this.prisma.product.findFirst({
          where: {
            id: productId,
            tenantId: _user.tenantId,
            fulfillmentMode: 'subscription',
            isActive: true,
          },
        });
        if (!product) {
          throw new BadRequestException('Subscription plan not found');
        }
        return {
          unitPrice: Number(product.basePrice),
          description: product.name,
          meta: { productId: product.id },
        };
      },
      buildLine: (resolved) => ({
        itemKind: 'subscription',
        description: resolved.description,
        unitPrice: resolved.unitPrice,
        quantity: 1,
        lineTotal: resolved.unitPrice,
        productId: resolved.meta?.productId,
      }),
      commit: async () => {
        /* subscription period start — Phase next */
      },
    });
  }
}
