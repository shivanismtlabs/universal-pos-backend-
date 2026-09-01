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
  buildTaxProfile,
  computeInvoiceTax,
} from '../../common/tax-engine';
import {
  ApplyLateFeeDto,
  CreateInvoiceDto,
  CreateLayawayDto,
  CreateOrderFeeDto,
  UpdateLayawayDto,
} from './dto/billing.dto';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async createFee(user: AuthUser, orderId: string, dto: CreateOrderFeeDto) {
    await this.assertOrder(user.tenantId, orderId);

    if (dto.stockUnitId || dto.inventoryUnitId) {
      const unitId = dto.stockUnitId ?? dto.inventoryUnitId!;
      const unit = await this.prisma.stockUnit.findFirst({
        where: { id: unitId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!unit) throw new NotFoundException('Stock unit not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const fee = await tx.orderFee.create({
        data: {
          tenantId: user.tenantId,
          orderId,
          stockUnitId: dto.stockUnitId ?? dto.inventoryUnitId ?? null,
          feeCode: dto.feeType,
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
      feeType: 'late',
      amount,
      reason: `${daysLate} day(s) late × ₹${dailyRate}/day`,
    });
  }

  async createLayaway(user: AuthUser, orderId: string, dto: CreateLayawayDto) {
    await this.assertOrder(user.tenantId, orderId);

    return this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const installment of dto.installments) {
        created.push(
          await tx.layawaySchedule.create({
            data: {
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
      where: { orderId },
      orderBy: { dueBy: 'asc' },
    });
  }

  async updateLayaway(user: AuthUser, id: string, dto: UpdateLayawayDto) {
    const layaway = await this.prisma.layawaySchedule.findFirst({
      where: { id, order: { tenantId: user.tenantId } },
    });
    if (!layaway) {
      throw new NotFoundException('Layaway installment not found');
    }
    return this.prisma.layawaySchedule.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.status === 'paid' ? { paidAt: new Date() } : {}),
      },
    });
  }

  async createInvoice(user: AuthUser, orderId: string, dto: CreateInvoiceDto) {
    const order = await this.assertOrder(user.tenantId, orderId);
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { taxMode: true, taxId: true, settings: true },
    });
    const profile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId,
      settings: tenant.settings,
    });

    return this.prisma.$transaction(async (tx) => {
      return this.createInvoiceInTx(tx, user, order, profile, dto);
    });
  }

  /**
   * Create a sale invoice inside an existing transaction (exchange / checkout).
   * Prefer order.taxTotal when already computed by the tax engine.
   * Split bills: pass `amount` + `splitPartIndex` to mint one invoice per part.
   */
  async createInvoiceInTx(
    tx: PrismaTx,
    user: AuthUser,
    order: {
      id: string;
      subtotal: Prisma.Decimal | string | number;
      taxTotal?: Prisma.Decimal | string | number | null;
      discountTotal?: Prisma.Decimal | string | number | null;
    },
    profile: ReturnType<typeof buildTaxProfile>,
    dto: CreateInvoiceDto = {},
  ) {
    const subtotal = Number(order.subtotal);
    const existingTax = Number(order.taxTotal ?? 0);
    const { totalTax } =
      existingTax > 0
        ? { totalTax: existingTax }
        : computeInvoiceTax(profile, subtotal);

    const feesAgg = await tx.orderFee.aggregate({
      where: { tenantId: user.tenantId, orderId: order.id },
      _sum: { amount: true },
    });
    const feesTotal = Number(feesAgg._sum.amount ?? 0);
    const discount = Number(order.discountTotal ?? 0);
    const orderGrand = Math.max(0, subtotal + totalTax + feesTotal - discount);

    // Idempotent replay for the same split part
    if (dto.splitPartIndex != null && Number.isFinite(dto.splitPartIndex)) {
      const prior = await tx.invoice.findMany({
        where: { tenantId: user.tenantId, orderId: order.id },
        select: { id: true, taxBreakdown: true, invoiceNumber: true, grandTotal: true, cgst: true, sgst: true, igst: true, taxIdSnapshot: true, createdAt: true, updatedAt: true, tenantId: true, orderId: true },
      });
      const hit = prior.find((inv) => {
        const b =
          inv.taxBreakdown && typeof inv.taxBreakdown === 'object'
            ? (inv.taxBreakdown as Record<string, unknown>)
            : {};
        return Number(b.splitPartIndex) === Number(dto.splitPartIndex);
      });
      if (hit) return hit;
    }

    const isSplitPart =
      dto.amount != null &&
      Number.isFinite(Number(dto.amount)) &&
      Number(dto.amount) > 0 &&
      dto.splitPartIndex != null;

    const grandTotal = isSplitPart
      ? Math.round(Number(dto.amount) * 100) / 100
      : orderGrand;

    if (grandTotal <= 0) {
      throw new BadRequestException('Invoice amount must be greater than 0');
    }

    const ratio =
      isSplitPart && orderGrand > 0.009 ? grandTotal / orderGrand : 1;
    const partTax = Math.round(totalTax * ratio * 100) / 100;
    const cgst = dto.useIgst ? 0 : Math.round((partTax / 2) * 100) / 100;
    const sgst = dto.useIgst ? 0 : Math.round((partTax - cgst) * 100) / 100;
    const igst = dto.useIgst ? partTax : 0;

    const invoiceNumber = await this.generateInvoiceNumber(
      tx,
      user.tenantId,
      dto.prefix || 'INV-',
    );

    const invoice = await tx.invoice.create({
      data: {
        tenantId: user.tenantId,
        orderId: order.id,
        invoiceNumber,
        taxIdSnapshot: dto.gstin ?? profile.taxId ?? null,
        taxBreakdown: {
          cgst,
          sgst,
          igst,
          rate: profile.rate,
          taxMode: profile.taxMode,
          placeOfSupply: dto.placeOfSupply ?? null,
          ...(isSplitPart
            ? {
                splitPart: true,
                splitPartIndex: Number(dto.splitPartIndex),
                splitPartLabel:
                  dto.splitPartLabel?.trim() ||
                  `Part ${Number(dto.splitPartIndex) + 1}`,
                partAmount: grandTotal,
                orderGrandTotal: orderGrand,
                ...(dto.paymentId ? { paymentId: dto.paymentId } : {}),
              }
            : {}),
        },
        cgst: cgst.toFixed(2),
        sgst: sgst.toFixed(2),
        igst: igst.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
      },
    });

    // Keep order tax snapshot from full ticket (do not overwrite with part tax)
    if (!isSplitPart) {
      await tx.order.update({
        where: { id: order.id },
        data: { taxTotal: totalTax.toFixed(2) },
      });
    }

    await this.paymentsService.recalculateBalance(tx, user.tenantId, order.id);
    return invoice;
  }

  /**
   * Mint the next split-bill part invoice for an order (or a full ticket invoice).
   * Safe to call from checkout / follow-up pay / Stripe finalize.
   */
  async issueSaleInvoice(
    user: AuthUser,
    orderId: string,
    opts?: {
      amount?: number;
      splitPartIndex?: number;
      splitPartLabel?: string;
      paymentId?: string;
      onlyIfMissing?: boolean;
    },
  ) {
    if (opts?.onlyIfMissing) {
      const existing = await this.prisma.invoice.count({
        where: { tenantId: user.tenantId, orderId },
      });
      if (existing > 0) {
        return this.prisma.invoice.findFirst({
          where: { tenantId: user.tenantId, orderId },
          orderBy: { createdAt: 'asc' },
        });
      }
    }
    return this.createInvoice(user, orderId, {
      amount: opts?.amount,
      splitPartIndex: opts?.splitPartIndex,
      splitPartLabel: opts?.splitPartLabel,
      paymentId: opts?.paymentId,
    });
  }

  async listInvoices(user: AuthUser, orderId: string) {
    await this.assertOrder(user.tenantId, orderId);
    return this.prisma.invoice.findMany({
      where: { tenantId: user.tenantId, orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertOrder(tenantId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        rentalExt: {
          select: {
            returnDueDate: true,
            pickupDate: true,
            lifecycle: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return {
      ...order,
      returnDueDate: order.rentalExt?.returnDueDate ?? null,
    };
  }

  private async generateInvoiceNumber(
    tx: PrismaTx,
    tenantId: string,
    prefix: string = 'INV-',
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const random = Math.random().toString(36).slice(2, 6).toUpperCase();
      const candidate = `${prefix}${Date.now().toString(36).toUpperCase()}-${random}`;
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
