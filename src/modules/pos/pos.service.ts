import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderItemType, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import { CheckoutDto } from './dto/pos.dto';

const READY_ELIGIBLE_STATUSES: OrderStatus[] = [
  OrderStatus.reserved,
  OrderStatus.fitted,
];

const ORDER_INCLUDE = {
  customer: { select: { id: true, fullName: true, phone: true, email: true } },
  store: { select: { id: true, name: true, code: true, address: true } },
  items: {
    include: {
      inventoryUnit: {
        select: { id: true, barcodeSku: true, size: true },
      },
      retailSku: { select: { id: true, sku: true } },
    },
  },
  fees: true,
  payments: { orderBy: { createdAt: 'desc' as const } },
} as const;

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async checkout(user: AuthUser, dto: CheckoutDto) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertReadyForCheckout(
      order.items,
      order.pickupDate,
      order.returnDueDate,
    );

    const payments = [];
    for (const paymentDto of dto.payments) {
      const payment = await this.paymentsService.create(user, {
        orderId: dto.orderId,
        method: paymentDto.method,
        amount: paymentDto.amount,
        type: paymentDto.type,
        idempotencyKey: paymentDto.idempotencyKey,
      });
      payments.push(payment);
    }

    if (dto.markReady && READY_ELIGIBLE_STATUSES.includes(order.status)) {
      await this.prisma.rentalOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.ready },
      });
    }

    const finalOrder = await this.prisma.rentalOrder.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: ORDER_INCLUDE,
    });

    return { order: finalOrder, payments };
  }

  async getReceipt(user: AuthUser, orderId: string) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const succeededPayments = order.payments.filter(
      (p) => p.status === 'succeeded',
    );

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      store: {
        name: order.store.name,
        code: order.store.code,
        address: order.store.address,
      },
      customer: {
        fullName: order.customer.fullName,
        phone: order.customer.phone,
        email: order.customer.email,
      },
      items: order.items.map((item) => ({
        id: item.id,
        itemType: item.itemType,
        size: item.size,
        unitPrice: item.unitPrice,
        discount: item.discount,
        taxAmount: item.taxAmount,
        inventoryUnit: item.inventoryUnit
          ? {
              barcodeSku: item.inventoryUnit.barcodeSku,
              size: item.inventoryUnit.size,
            }
          : null,
        retailSku: item.retailSku ? { sku: item.retailSku.sku } : null,
      })),
      totals: {
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        depositTotal: order.depositTotal,
        balanceDue: order.balanceDue,
      },
      payments: succeededPayments.map((p) => ({
        id: p.id,
        type: p.type,
        method: p.method,
        amount: p.amount,
        paidAt: p.paidAt,
      })),
      printedAt: new Date(),
    };
  }

  /** FR-ORD-05: rental items need pickup/return dates + assigned inventory units before checkout */
  private assertReadyForCheckout(
    items: Array<{ itemType: OrderItemType; inventoryUnitId: string | null }>,
    pickupDate: Date | null,
    returnDueDate: Date | null,
  ) {
    const hasRentalItems = items.some(
      (item) => item.itemType === OrderItemType.rental_unit,
    );
    if (!hasRentalItems) {
      return;
    }

    if (!pickupDate || !returnDueDate) {
      throw new BadRequestException(
        'pickupDate and returnDueDate are required before checkout for rental orders',
      );
    }

    const missingUnit = items.some(
      (item) =>
        item.itemType === OrderItemType.rental_unit && !item.inventoryUnitId,
    );
    if (missingUnit) {
      throw new BadRequestException(
        'Every rental item must have an assigned inventory unit before checkout',
      );
    }
  }
}
