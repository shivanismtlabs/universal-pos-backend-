import { FeeType } from '@prisma/client';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import {
  ApplyLateFeeDto,
  CreateInvoiceDto,
  CreateLayawayDto,
  CreateOrderFeeDto,
  UpdateLayawayDto,
} from './dto/billing.dto';

type PrismaTx = Prisma.TransactionClient;

const GST_RATE = 0.05;

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  // ─── Fees ────────────────────────────────────────────────────────────────

  async createFee(user: AuthUser, orderId: string, dto: CreateOrderFeeDto) {
    await this.assertOrder(user.tenantId, orderId);

    if (dto.inventoryUnitId) {
      const unit = await this.prisma.inventoryUnit.findFirst({
        where: { id: dto.inventoryUnitId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!unit) {
        throw new NotFoundException('Inventory unit not found');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const fee = await tx.orderFee.create({
        data: {
          tenantId: user.tenantId,
          orderId,
          inventoryUnitId: dto.inventoryUnitId,
          feeType: dto.feeType,
          amount: dto.amount.toFixed(2),
          reason: dto.reason,
        },
      });

      await this.paymentsService.recalculateBalance(tx, user.tenantId, orderId);

      return fee;
    });
  }

  async listFees(user: AuthUser, orderId: string) {
    await this.assertOrder(user.tenantId, orderId);
    return this.prisma.orderFee.findMany({
      where: { tenantId: user.tenantId, orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Auto late fee from returnDueDate vs today (FR-BIL-03) */
  async applyLateFee(
    user: AuthUser,
    orderId: string,
    dto: ApplyLateFeeDto,
  ) {
    const order = await this.assertOrder(user.tenantId, orderId);
    if (!order.returnDueDate) {
      throw new BadRequestException('Order has no return due date');
    }

    const due = new Date(order.returnDueDate);
    due.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysLate = Math.floor(
      (today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysLate <= 0) {
      throw new BadRequestException('Order is not overdue');
    }

    const dailyRate = dto.dailyRate && dto.dailyRate > 0 ? dto.dailyRate : 200;
    const amount = daysLate * dailyRate;

    return this.createFee(user, orderId, {
      feeType: FeeType.late,
      amount,
      reason: `${daysLate} day(s) late × ₹${dailyRate}/day`,
    });
  }

  // ─── Layaway ─────────────────────────────────────────────────────────────

  async createLayaway(user: AuthUser, orderId: string, dto: CreateLayawayDto) {
    await this.assertOrder(user.tenantId, orderId);

    return this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const installment of dto.installments) {
        created.push(
          await tx.layawaySchedule.create({
            data: {
              tenantId: user.tenantId,
              orderId,
              dueBy: new Date(installment.dueBy),
              installmentAmount: installment.installmentAmount.toFixed(2),
            },
          }),
        );
      }
      return created;
    });
  }

  async listLayaway(user: AuthUser, orderId: string) {
    await this.assertOrder(user.tenantId, orderId);
    return this.prisma.layawaySchedule.findMany({
      where: { tenantId: user.tenantId, orderId },
      orderBy: { dueBy: 'asc' },
    });
  }

  async updateLayaway(user: AuthUser, id: string, dto: UpdateLayawayDto) {
    const layaway = await this.prisma.layawaySchedule.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!layaway) {
      throw new NotFoundException('Layaway installment not found');
    }
    return this.prisma.layawaySchedule.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  // ─── Invoices ────────────────────────────────────────────────────────────

  async createInvoice(user: AuthUser, orderId: string, dto: CreateInvoiceDto) {
    const order = await this.assertOrder(user.tenantId, orderId);

    return this.prisma.$transaction(async (tx) => {
      const subtotal = Number(order.subtotal);
      const totalTax = subtotal * GST_RATE;

      const cgst = dto.useIgst ? 0 : totalTax / 2;
      const sgst = dto.useIgst ? 0 : totalTax / 2;
      const igst = dto.useIgst ? totalTax : 0;

      const feesAgg = await tx.orderFee.aggregate({
        where: { tenantId: user.tenantId, orderId },
        _sum: { amount: true },
      });
      const feesTotal = Number(feesAgg._sum.amount ?? 0);

      const grandTotal = subtotal + totalTax + feesTotal;

      const invoiceNumber = await this.generateInvoiceNumber(tx, user.tenantId);

      const invoice = await tx.invoice.create({
        data: {
          tenantId: user.tenantId,
          orderId,
          invoiceNumber,
          gstin: dto.gstin,
          placeOfSupply: dto.placeOfSupply,
          cgst: cgst.toFixed(2),
          sgst: sgst.toFixed(2),
          igst: igst.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
        },
      });

      await tx.rentalOrder.update({
        where: { id: orderId },
        data: { taxTotal: totalTax.toFixed(2) },
      });

      await this.paymentsService.recalculateBalance(tx, user.tenantId, orderId);

      return invoice;
    });
  }

  async listInvoices(user: AuthUser, orderId: string) {
    await this.assertOrder(user.tenantId, orderId);
    return this.prisma.invoice.findMany({
      where: { tenantId: user.tenantId, orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private async assertOrder(tenantId: string, orderId: string) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  private async generateInvoiceNumber(
    tx: PrismaTx,
    tenantId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const random = Math.random().toString(36).slice(2, 6).toUpperCase();
      const candidate = `INV-${Date.now().toString(36).toUpperCase()}-${random}`;
      const exists = await tx.invoice.findFirst({
        where: { tenantId, invoiceNumber: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new ConflictException(
      'Failed to generate a unique invoice number, please retry',
    );
  }
}
