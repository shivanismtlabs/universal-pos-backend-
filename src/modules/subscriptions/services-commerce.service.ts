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
} from '@prisma/client';
import { parseCommerceModes } from '../../common/commerce-schema';
import { validateSku } from '../../common/sell-units';
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

  async listServices(user: AuthUser) {
    await this.assertServiceMode(user.tenantId);
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.service,
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      items: rows.map((p) => {
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
          isActive: p.isActive,
          category: p.category,
          createdAt: p.createdAt,
        };
      }),
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
          kind: 'service',
          fulfillmentMode: FulfillmentMode.service,
          trackQty: false,
          trackSerial: false,
          basePrice: money(dto.price).toFixed(2),
          meta:
            dto.durationMinutes != null
              ? { durationMinutes: dto.durationMinutes }
              : {},
        },
        include: { category: { select: { id: true, name: true } } },
      });
      return {
        id: product.id,
        title: product.name,
        sku: product.skuCode,
        description: product.description,
        price: product.basePrice,
        durationMinutes: dto.durationMinutes ?? null,
        isActive: product.isActive,
        category: product.category,
      };
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
        fulfillmentMode: FulfillmentMode.service,
      },
    });
    if (!existing) throw new NotFoundException('Service not found');
    const updated = await this.prisma.product.update({
      where: { id },
      data: { isActive },
      include: { category: { select: { id: true, name: true } } },
    });
    const meta =
      updated.meta && typeof updated.meta === 'object'
        ? (updated.meta as Record<string, unknown>)
        : {};
    return {
      id: updated.id,
      title: updated.name,
      sku: updated.skuCode,
      price: updated.basePrice,
      isActive: updated.isActive,
      durationMinutes:
        typeof meta.durationMinutes === 'number'
          ? meta.durationMinutes
          : null,
      category: updated.category,
    };
  }

  async bill(user: AuthUser, dto: BillServiceDto) {
    const tenant = await this.assertServiceMode(user.tenantId);
    const locationId = await this.defaultLocationId(
      user.tenantId,
      dto.locationId,
    );

    const customer = await this.prisma.customer.findFirst({
      where: {
        id: dto.customerId,
        tenantId: user.tenantId,
        deletedAt: null,
      },
      select: { id: true, fullName: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.service,
        isActive: true,
      },
    });
    if (!product) throw new NotFoundException('Service not found or inactive');

    const price = money(product.basePrice);
    if (price.lte(0)) {
      throw new BadRequestException('Service price must be greater than 0');
    }

    const methodMap: Record<string, PaymentMethod> = {
      cash: PaymentMethod.cash,
      card: PaymentMethod.card,
      upi: PaymentMethod.upi,
    };
    const method = methodMap[dto.paymentMethod ?? 'cash'] ?? PaymentMethod.cash;
    const idem =
      dto.idempotencyKey?.trim() ||
      `svc-bill-${user.tenantId}-${customer.id}-${product.id}-${Date.now()}`;

    if (dto.appointmentId) {
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
          customerId: customer.id,
          orderNumber,
          kind: OrderKind.service,
          status: OrderStatus.closed,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          subtotal: price.toFixed(2),
          taxTotal: '0.00',
          discountTotal: '0.00',
          balanceDue: '0.00',
          meta: {
            serviceBill: true,
            productId: product.id,
            ...(dto.appointmentId
              ? { appointmentId: dto.appointmentId }
              : {}),
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
          quantity: 1,
          unitPrice: price.toFixed(2),
          lineTotal: price.toFixed(2),
          taxAmount: '0.00',
        },
      });

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          type: PaymentType.payment,
          method,
          amount: price.toFixed(2),
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
    };
  }

  async summary(user: AuthUser) {
    await this.assertServiceMode(user.tenantId);
    const [services, openApts] = await Promise.all([
      this.prisma.product.count({
        where: {
          tenantId: user.tenantId,
          fulfillmentMode: FulfillmentMode.service,
          isActive: true,
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
