import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  FulfillmentMode,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
  ProductKind,
} from '@prisma/client';
import { parseCommerceModes } from '../../common/commerce-schema';
import { validateSku } from '../../common/sell-units';
import { resolveProductTaxRatePercent } from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  BillServiceDto,
  CreateServiceProductDto,
} from './dto/subscriptions.dto';

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

@Injectable()
export class ServicesCommerceService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertServiceMode(tenantId: string) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { settings: true, currencyCode: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    if (!parsed.modes.includes('service')) {
      throw new BadRequestException(
        'Enable service mode in shop setup before using this feature',
      );
    }
    return tenant;
  }

  private async defaultLocationId(tenantId: string, preferred?: string) {
    if (preferred) {
      const loc = await this.prisma.location.findFirst({
        where: { id: preferred, tenantId, isActive: true },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException('Location not found');
      return loc.id;
    }
    const main = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true, code: 'MAIN' },
      select: { id: true },
    });
    if (main) return main.id;
    const any = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!any) throw new BadRequestException('No active location configured');
    return any.id;
  }

  private mapServiceRow(p: {
    id: string;
    name: string;
    skuCode: string;
    description: string | null;
    basePrice: Prisma.Decimal;
    isActive: boolean;
    meta: unknown;
    taxCode?: string | null;
    createdAt?: Date;
    category: { id: string; name: string } | null;
  }) {
    const meta =
      p.meta && typeof p.meta === 'object'
        ? (p.meta as Record<string, unknown>)
        : {};
    return {
      id: p.id,
      title: p.name,
      sku: p.skuCode,
      description: p.description,
      price: p.basePrice,
      durationMinutes:
        typeof meta.durationMinutes === 'number'
          ? meta.durationMinutes
          : Number(meta.durationMinutes ?? 0) || null,
      durationUnit:
        typeof meta.durationUnit === 'string' && meta.durationUnit.trim()
          ? meta.durationUnit.trim()
          : null,
      durationQuantity:
        typeof meta.durationQuantity === 'number' && meta.durationQuantity > 0
          ? meta.durationQuantity
          : null,
      sessionDurationMinutes:
        typeof meta.sessionDurationMinutes === 'number' && meta.sessionDurationMinutes > 0
          ? meta.sessionDurationMinutes
          : null,
      taxRatePercent: resolveProductTaxRatePercent({
        taxCode: p.taxCode,
        meta: p.meta,
      }),
      isActive: p.isActive,
      category: p.category,
      createdAt: p.createdAt,
    };
  }

  async listServices(user: AuthUser) {
    await this.assertServiceMode(user.tenantId);
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { fulfillmentMode: FulfillmentMode.service },
          { kind: ProductKind.service },
        ],
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      items: rows.map((p) => this.mapServiceRow(p)),
      counts: {
        services: rows.length,
        active: rows.filter((r) => r.isActive).length,
      },
    };
  }

  async createService(user: AuthUser, dto: CreateServiceProductDto) {
    await this.assertServiceMode(user.tenantId);
    const skuErr = validateSku(dto.sku);
    if (skuErr) throw new BadRequestException(skuErr);

    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!cat) throw new NotFoundException('Category not found');

    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.title.trim(),
          skuCode: dto.sku.trim().toUpperCase(),
          description: dto.description?.trim() || null,
          kind: ProductKind.service,
          fulfillmentMode: FulfillmentMode.service,
          trackQty: false,
          trackSerial: false,
          canSell: true,
          availableInPos: true,
          basePrice: money(dto.price).toFixed(2),
          meta: {
            ...(dto.durationMinutes != null ? { durationMinutes: dto.durationMinutes } : {}),
            ...(dto.durationUnit ? { durationUnit: dto.durationUnit.trim() } : {}),
            ...(dto.durationQuantity != null ? { durationQuantity: dto.durationQuantity } : {}),
            ...(dto.sessionDurationMinutes != null ? { sessionDurationMinutes: dto.sessionDurationMinutes } : {}),
          },
        },
        include: { category: { select: { id: true, name: true } } },
      });
      return this.mapServiceRow(product);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('SKU already exists for this shop');
      }
      throw e;
    }
  }

  async setActive(user: AuthUser, id: string, isActive: boolean) {
    await this.assertServiceMode(user.tenantId);
    const existing = await this.prisma.product.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        OR: [
          { fulfillmentMode: FulfillmentMode.service },
          { kind: ProductKind.service },
        ],
      },
    });
    if (!existing) throw new NotFoundException('Service not found');
    const updated = await this.prisma.product.update({
      where: { id },
      data: { isActive },
      include: { category: { select: { id: true, name: true } } },
    });
    return this.mapServiceRow(updated);
  }

  async bill(user: AuthUser, dto: BillServiceDto) {
    const tenant = await this.assertServiceMode(user.tenantId);
    const locationId = await this.defaultLocationId(
      user.tenantId,
      dto.locationId,
    );

    let customer: { id: string; fullName: string } | null = null;
    if (dto.customerId) {
      customer = await this.prisma.customer.findFirst({
        where: {
          id: dto.customerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true, fullName: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
    }

    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        tenantId: user.tenantId,
        isActive: true,
        OR: [
          { fulfillmentMode: FulfillmentMode.service },
          { kind: ProductKind.service },
        ],
      },
    });
    if (!product) throw new NotFoundException('Service not found or inactive');

    const unitPrice = money(product.basePrice);
    if (unitPrice.lte(0)) {
      throw new BadRequestException('Service price must be greater than 0');
    }

    const rawQty = Number(dto.quantity);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(999, rawQty) : 1;
    const subtotal = unitPrice.mul(qty).toDecimalPlaces(2);
    const taxRate =
      resolveProductTaxRatePercent({
        taxCode: product.taxCode,
        meta: product.meta,
      }) ?? 0;
    const taxTotal =
      taxRate > 0
        ? subtotal.mul(taxRate).div(100).toDecimalPlaces(2)
        : money(0);
    const grandTotal = subtotal.add(taxTotal);

    const meta =
      product.meta && typeof product.meta === 'object'
        ? (product.meta as Record<string, unknown>)
        : {};
    const durationMinutes =
      typeof meta.durationMinutes === 'number'
        ? meta.durationMinutes
        : Number(meta.durationMinutes ?? 0) || null;
    const durationUnit =
      typeof meta.durationUnit === 'string' && meta.durationUnit.trim()
        ? meta.durationUnit.trim()
        : null;
    const durationQuantity =
      typeof meta.durationQuantity === 'number' && meta.durationQuantity > 0
        ? meta.durationQuantity
        : null;
    const sessionDurationMinutes =
      typeof meta.sessionDurationMinutes === 'number' && meta.sessionDurationMinutes > 0
        ? meta.sessionDurationMinutes
        : null;

    const orderedUnitSymbol = dto.orderedUnitSymbol?.trim() || durationUnit || 'service';

    const methodMap: Record<string, PaymentMethod> = {
      cash: PaymentMethod.cash,
      card: PaymentMethod.card,
      upi: PaymentMethod.upi,
    };
    const method = methodMap[dto.paymentMethod ?? 'cash'] ?? PaymentMethod.cash;
    const idem =
      dto.idempotencyKey?.trim() ||
      `svc-bill-${user.tenantId}-${customer?.id ?? 'walkin'}-${product.id}-${Date.now()}`;

    const existingPay = await this.prisma.payment.findFirst({
      where: { tenantId: user.tenantId, idempotencyKey: idem },
      include: {
        order: { select: { id: true, orderNumber: true, kind: true } },
      },
    });
    if (existingPay?.order) {
      return {
        order: {
          id: existingPay.order.id,
          orderNumber: existingPay.order.orderNumber,
          kind: existingPay.order.kind,
        },
        payment: {
          id: existingPay.id,
          amount: existingPay.amount,
          method: existingPay.method,
        },
        service: {
          id: product.id,
          title: product.name,
          price: product.basePrice,
        },
        customer,
        totals: {
          subtotal: subtotal.toFixed(2),
          taxTotal: taxTotal.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          taxRatePercent: taxRate,
          quantity: qty,
          orderedUnitSymbol,
        },
      };
    }

    if (dto.appointmentId) {
      if (!customer) {
        throw new BadRequestException(
          'Customer is required when linking an appointment',
        );
      }
      const apt = await this.prisma.appointment.findFirst({
        where: {
          id: dto.appointmentId,
          tenantId: user.tenantId,
          customerId: customer.id,
        },
        select: { id: true },
      });
      if (!apt) throw new NotFoundException('Appointment not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const orderCount = await tx.order.count({
        where: { tenantId: user.tenantId },
      });
      const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          customerId: customer?.id ?? null,
          orderNumber,
          kind: OrderKind.service,
          status: OrderStatus.closed,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          subtotal: subtotal.toFixed(2),
          taxTotal: taxTotal.toFixed(2),
          discountTotal: '0.00',
          balanceDue: '0.00',
          meta: {
            serviceBill: true,
            productId: product.id,
            quantity: qty,
            orderedQuantity: qty,
            orderedUnitSymbol,
            ...(durationMinutes != null ? { durationMinutes } : {}),
            ...(durationUnit ? { durationUnit } : {}),
            ...(durationQuantity != null ? { durationQuantity } : {}),
            ...(sessionDurationMinutes != null ? { sessionDurationMinutes } : {}),
            ...(taxRate > 0 ? { taxRatePercent: taxRate } : {}),
            ...(dto.appointmentId
              ? { appointmentId: dto.appointmentId }
              : {}),
            ...(customer ? {} : { walkIn: true }),
          },
        },
      });

      await tx.orderItem.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          itemKind: OrderItemKind.service,
          productId: product.id,
          description: product.name,
          quantity: qty,
          unitPrice: unitPrice.toFixed(2),
          lineTotal: subtotal.toFixed(2),
          taxAmount: taxTotal.toFixed(2),
          meta: {
            orderedQuantity: qty,
            orderedUnitSymbol,
            ...(durationMinutes != null ? { durationMinutes } : {}),
            ...(durationUnit ? { durationUnit } : {}),
            ...(durationQuantity != null ? { durationQuantity } : {}),
            ...(sessionDurationMinutes != null ? { sessionDurationMinutes } : {}),
            ...(taxRate > 0 ? { taxRatePercent: taxRate } : {}),
          },
        },
      });

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          type: PaymentType.payment,
          method,
          amount: grandTotal.toFixed(2),
          status: PaymentStatus.succeeded,
          idempotencyKey: idem,
          takenByUserId: user.userId,
        },
      });

      if (dto.appointmentId) {
        await tx.appointment.update({
          where: { id: dto.appointmentId },
          data: { status: AppointmentStatus.completed },
        });
      }

      return { order, payment };
    });

    return {
      order: {
        id: result.order.id,
        orderNumber: result.order.orderNumber,
        kind: result.order.kind,
      },
      payment: {
        id: result.payment.id,
        amount: result.payment.amount,
        method: result.payment.method,
      },
      service: {
        id: product.id,
        title: product.name,
        price: product.basePrice,
      },
      customer,
      totals: {
        subtotal: subtotal.toFixed(2),
        taxTotal: taxTotal.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        taxRatePercent: taxRate,
        quantity: qty,
      },
    };
  }

  async summary(user: AuthUser) {
    await this.assertServiceMode(user.tenantId);
    const [services, openApts] = await Promise.all([
      this.prisma.product.count({
        where: {
          tenantId: user.tenantId,
          isActive: true,
          OR: [
            { fulfillmentMode: FulfillmentMode.service },
            { kind: ProductKind.service },
          ],
        },
      }),
      this.prisma.appointment.count({
        where: {
          tenantId: user.tenantId,
          status: {
            in: [AppointmentStatus.scheduled, AppointmentStatus.checked_in],
          },
        },
      }),
    ]);
    return { services, openAppointments: openApts };
  }
}
