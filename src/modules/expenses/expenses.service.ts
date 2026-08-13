import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { saveProductImage } from '../../common/product-image';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesQueryDto,
  UpdateExpenseDto,
} from './dto/expenses.dto';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  listCategories(user: AuthUser) {
    return this.prisma.expenseCategory.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(user: AuthUser, dto: CreateExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
      },
    });
  }

  async list(user: AuthUser, query: ListExpensesQueryDto) {
    const where: {
      tenantId: string;
      locationId?: string;
      categoryId?: string;
      status?: string | { not: string };
      isPettyCash?: boolean;
      spentAt?: { gte?: Date; lte?: Date };
    } = { tenantId: user.tenantId };
    if (query.locationId) where.locationId = query.locationId;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.pettyCash === true) where.isPettyCash = true;
    if (query.status && query.status !== 'all') {
      where.status = query.status;
    } else if (!query.status) {
      where.status = { not: 'voided' };
    }
    if (query.from || query.to) {
      where.spentAt = {};
      if (query.from) where.spentAt.gte = new Date(query.from);
      if (query.to) where.spentAt.lte = new Date(query.to);
    }

    const items = await this.prisma.expense.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        createdBy: { select: { id: true, fullName: true } },
        approvedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { spentAt: 'desc' },
      take: 200,
    });

    const total = items
      .filter((e) => e.status === 'approved')
      .reduce((s, e) => s + Number(e.amount), 0);
    return { items, total, count: items.length };
  }

  private isExpenseApprover(user: AuthUser) {
    return user.roles.some(
      (r) => r === 'admin' || r === 'manager' || r === 'accountant',
    );
  }

  async create(user: AuthUser, dto: CreateExpenseDto) {
    if (dto.categoryId) {
      const cat = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.categoryId, tenantId: user.tenantId },
      });
      if (!cat) throw new NotFoundException('Category not found');
    }
    if (dto.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: dto.locationId, tenantId: user.tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    let receiptUrl: string | undefined;
    if (dto.receiptBase64?.trim()) {
      receiptUrl = await saveProductImage(user.tenantId, dto.receiptBase64);
    }

    const autoApprove = this.isExpenseApprover(user);
    return this.prisma.expense.create({
      data: {
        tenantId: user.tenantId,
        amount: dto.amount,
        spentAt: new Date(dto.spentAt),
        categoryId: dto.categoryId,
        locationId: dto.locationId,
        paymentMethod: dto.paymentMethod?.trim() || 'cash',
        notes: dto.notes?.trim(),
        isPettyCash: dto.isPettyCash ?? false,
        receiptUrl,
        createdById: user.userId,
        status: autoApprove ? 'approved' : 'pending',
        approvedById: autoApprove ? user.userId : undefined,
        approvedAt: autoApprove ? new Date() : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateExpenseDto) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status !== 'pending') {
      throw new BadRequestException('Only pending expenses can be edited');
    }
    return this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.amount != null ? { amount: dto.amount } : {}),
        ...(dto.spentAt ? { spentAt: new Date(dto.spentAt) } : {}),
        ...(dto.categoryId !== undefined
          ? { categoryId: dto.categoryId || null }
          : {}),
        ...(dto.locationId !== undefined
          ? { locationId: dto.locationId || null }
          : {}),
        ...(dto.paymentMethod
          ? { paymentMethod: dto.paymentMethod }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isPettyCash != null ? { isPettyCash: dto.isPettyCash } : {}),
      },
      include: {
        category: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });
  }

  async uploadReceipt(user: AuthUser, id: string, imageBase64: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status === 'voided') {
      throw new BadRequestException('Cannot attach receipt to a voided expense');
    }
    const receiptUrl = await saveProductImage(user.tenantId, imageBase64);
    return this.prisma.expense.update({
      where: { id },
      data: { receiptUrl },
      select: { id: true, receiptUrl: true },
    });
  }

  async approve(user: AuthUser, id: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to approve expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId, status: 'pending' },
    });
    if (!row) throw new NotFoundException('Pending expense not found');
    return this.prisma.expense.update({
      where: { id },
      data: {
        status: 'approved',
        approvedById: user.userId,
        approvedAt: new Date(),
        rejectReason: null,
      },
    });
  }

  async reject(user: AuthUser, id: string, reason?: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to reject expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId, status: 'pending' },
    });
    if (!row) throw new NotFoundException('Pending expense not found');
    return this.prisma.expense.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectReason: reason?.trim() || null,
        approvedById: user.userId,
        approvedAt: new Date(),
      },
    });
  }

  async void(user: AuthUser, id: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to void expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status === 'voided') return { ok: true, alreadyVoided: true };
    await this.prisma.expense.update({
      where: { id },
      data: { status: 'voided', voidedAt: new Date() },
    });
    return { ok: true };
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status === 'approved') {
      throw new BadRequestException(
        'Approved expenses must be voided, not deleted',
      );
    }
    await this.prisma.expense.delete({ where: { id } });
    return { ok: true };
  }

  async seedDefaults(user: AuthUser) {
    const defaults = [
      'Rent',
      'Utilities',
      'Salaries',
      'Supplies',
      'Transport',
      'Marketing',
      'Misc',
    ];
    for (const name of defaults) {
      await this.prisma.expenseCategory.upsert({
        where: {
          tenantId_name: { tenantId: user.tenantId, name },
        },
        create: { tenantId: user.tenantId, name },
        update: {},
      });
    }
    return this.listCategories(user);
  }
}
