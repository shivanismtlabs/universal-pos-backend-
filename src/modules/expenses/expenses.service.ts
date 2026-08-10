import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesQueryDto,
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
      spentAt?: { gte?: Date; lte?: Date };
    } = { tenantId: user.tenantId };
    if (query.locationId) where.locationId = query.locationId;
    if (query.categoryId) where.categoryId = query.categoryId;
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
      },
      orderBy: { spentAt: 'desc' },
      take: 200,
    });

    const total = items.reduce((s, e) => s + Number(e.amount), 0);
    return { items, total, count: items.length };
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
        createdById: user.userId,
      },
      include: {
        category: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Expense not found');
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
