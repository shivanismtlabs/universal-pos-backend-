import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaxMode } from '@prisma/client';
import { saveProductImage } from '../../common/product-image';
import {
  buildTaxProfile,
  computeLineTax,
} from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import { paginate, pageMeta } from '../../common/dto/pagination.dto';
import { AccountingPostingService } from '../accounting/posting.service';
import type { AuthUser } from '../auth/types';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseSummaryQueryDto,
  ListExpenseCategoriesQueryDto,
  ListExpensesQueryDto,
  PettyCashAdjustDto,
  PettyCashLedgerQueryDto,
  PettyCashOpeningDto,
  PettyCashQueryDto,
  PettyCashReplenishDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/expenses.dto';

const DEFAULT_CATEGORIES = [
  'Rent',
  'Electricity',
  'Water',
  'Internet',
  'Telephone',
  'Fuel',
  'Transportation',
  'Delivery',
  'Cleaning',
  'Maintenance',
  'Repairs',
  'Office Supplies',
  'Stationery',
  'Marketing',
  'Advertising',
  'Staff Refreshments',
  'Travel',
  'Miscellaneous',
] as const;

const expenseInclude = {
  category: {
    select: {
      id: true,
      name: true,
      receiptRequired: true,
      accountCode: true,
    },
  },
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  pettyLedger: {
    select: {
      id: true,
      kind: true,
      direction: true,
      amount: true,
      balanceAfter: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ExpenseInclude;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingPostingService,
  ) {}

  // ─── Categories ───────────────────────────────────────────────────────────

  listCategories(user: AuthUser, query: ListExpenseCategoriesQueryDto = {}) {
    return this.prisma.expenseCategory.findMany({
      where: {
        tenantId: user.tenantId,
        ...(query.activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        parent: { select: { id: true, name: true } },
        _count: { select: { expenses: true, children: true } },
      },
    });
  }

  async createCategory(user: AuthUser, dto: CreateExpenseCategoryDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Category name is required');
    if (dto.parentId) {
      const parent = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
    }
    try {
      return await this.prisma.expenseCategory.create({
        data: {
          tenantId: user.tenantId,
          name,
          parentId: dto.parentId,
          receiptRequired: dto.receiptRequired ?? false,
          accountCode: dto.accountCode?.trim() || null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('Category name already exists');
      }
      throw e;
    }
  }

  async updateCategory(
    user: AuthUser,
    id: string,
    dto: UpdateExpenseCategoryDto,
  ) {
    const row = await this.prisma.expenseCategory.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Category not found');

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('Category cannot be its own parent');
      }
      const parent = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
    }

    try {
      return await this.prisma.expenseCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.parentId !== undefined
            ? { parentId: dto.parentId || null }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.receiptRequired !== undefined
            ? { receiptRequired: dto.receiptRequired }
            : {}),
          ...(dto.accountCode !== undefined
            ? { accountCode: dto.accountCode?.trim() || null }
            : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('Category name already exists');
      }
      throw e;
    }
  }

  async deleteCategory(user: AuthUser, id: string) {
    const row = await this.prisma.expenseCategory.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { _count: { select: { expenses: true, children: true } } },
    });
    if (!row) throw new NotFoundException('Category not found');
    if (row._count.expenses > 0) {
      throw new BadRequestException(
        'Category has expenses — deactivate instead of deleting',
      );
    }
    if (row._count.children > 0) {
      throw new BadRequestException(
        'Category has child categories — move or deactivate them first',
      );
    }
    await this.prisma.expenseCategory.delete({ where: { id } });
    return { ok: true, deleted: true };
  }

  async seedDefaults(user: AuthUser) {
    let sortOrder = 0;
    for (const name of DEFAULT_CATEGORIES) {
      await this.prisma.expenseCategory.upsert({
        where: {
          tenantId_name: { tenantId: user.tenantId, name },
        },
        create: {
          tenantId: user.tenantId,
          name,
          sortOrder,
          isActive: true,
        },
        update: {},
      });
      sortOrder += 10;
    }
    return this.listCategories(user, {});
  }

  // ─── List / detail / summary ──────────────────────────────────────────────

  async list(user: AuthUser, query: ListExpensesQueryDto) {
    const where: Prisma.ExpenseWhereInput = { tenantId: user.tenantId };
    if (query.locationId) where.locationId = query.locationId;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.pettyCash === true) where.isPettyCash = true;
    if (query.status && query.status !== 'all') {
      where.status = query.status;
    } else if (!query.status) {
      where.status = { notIn: ['voided'] };
    }
    if (query.from || query.to) {
      where.spentAt = {};
      if (query.from) where.spentAt.gte = new Date(query.from);
      if (query.to) where.spentAt.lte = new Date(query.to);
    }

    const { page, limit, skip } = paginate(query.page, query.limit ?? 25);
    const [totalCount, items] = await this.prisma.$transaction([
      this.prisma.expense.count({ where }),
      this.prisma.expense.findMany({
        where,
        include: expenseInclude,
        orderBy: [{ spentAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    const approvedSum = await this.prisma.expense.aggregate({
      where: { ...where, status: 'approved' },
      _sum: { amount: true },
    });
    const total = Number(approvedSum._sum.amount ?? 0);
    return {
      items,
      total,
      count: totalCount,
      meta: pageMeta(totalCount, page, limit),
    };
  }

  async getById(user: AuthUser, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
      include: expenseInclude,
    });
    if (!row) throw new NotFoundException('Expense not found');
    return row;
  }

  async summary(user: AuthUser, query: ExpenseSummaryQueryDto) {
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const baseWhere: Prisma.ExpenseWhereInput = {
      tenantId: user.tenantId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };
    const rangeWhere: Prisma.ExpenseWhereInput = {
      ...baseWhere,
      ...(query.from || query.to
        ? {
            spentAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rangeItems, todayApproved, monthApproved, pendingAgg, rejectedAgg, fund] =
      await Promise.all([
        this.prisma.expense.findMany({
          where: {
            ...rangeWhere,
            status: { in: ['approved', 'pending', 'rejected'] },
          },
          select: {
            amount: true,
            status: true,
            paymentMethod: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
          },
        }),
        this.prisma.expense.aggregate({
          where: {
            ...baseWhere,
            status: 'approved',
            spentAt: { gte: todayStart },
          },
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({
          where: {
            ...baseWhere,
            status: 'approved',
            spentAt: { gte: monthStart },
          },
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({
          where: { ...baseWhere, status: 'pending' },
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({
          where: {
            ...rangeWhere,
            status: 'rejected',
          },
          _sum: { amount: true },
        }),
        this.getOrCreateFund(user.tenantId, query.locationId ?? null),
      ]);

    const byCategoryMap = new Map<
      string,
      { categoryId: string | null; name: string; amount: number; count: number }
    >();
    const byPaymentMap = new Map<
      string,
      { paymentMethod: string; amount: number; count: number }
    >();
    let approvedTotal = 0;

    for (const e of rangeItems) {
      const amt = Number(e.amount);
      if (e.status === 'approved') {
        approvedTotal += amt;
        const key = e.categoryId ?? '__none__';
        const prev = byCategoryMap.get(key) ?? {
          categoryId: e.categoryId,
          name: e.category?.name ?? 'Uncategorized',
          amount: 0,
          count: 0,
        };
        prev.amount += amt;
        prev.count += 1;
        byCategoryMap.set(key, prev);

        const pm = e.paymentMethod || 'other';
        const pmPrev = byPaymentMap.get(pm) ?? {
          paymentMethod: pm,
          amount: 0,
          count: 0,
        };
        pmPrev.amount += amt;
        pmPrev.count += 1;
        byPaymentMap.set(pm, pmPrev);
      }
    }

    return {
      todayTotal: Number(todayApproved._sum.amount ?? 0),
      monthTotal: Number(monthApproved._sum.amount ?? 0),
      pendingTotal: Number(pendingAgg._sum.amount ?? 0),
      approvedTotal,
      rejectedTotal: Number(rejectedAgg._sum.amount ?? 0),
      pettyCashBalance: Number(fund.balance),
      byCategory: [...byCategoryMap.values()].sort(
        (a, b) => b.amount - a.amount,
      ),
      byPaymentMethod: [...byPaymentMap.values()].sort(
        (a, b) => b.amount - a.amount,
      ),
    };
  }

  // ─── Create / update ──────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateExpenseDto) {
    if (dto.idempotencyKey?.trim()) {
      const existing = await this.prisma.expense.findFirst({
        where: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey.trim(),
        },
        include: expenseInclude,
      });
      if (existing) return { ...existing, replayed: true as const };
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { taxMode: true, taxId: true, settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    let category: {
      id: string;
      receiptRequired: boolean;
      isActive: boolean;
    } | null = null;
    if (dto.categoryId) {
      category = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.categoryId, tenantId: user.tenantId },
        select: { id: true, receiptRequired: true, isActive: true },
      });
      if (!category) throw new NotFoundException('Category not found');
      if (!category.isActive) {
        throw new BadRequestException('Category is inactive');
      }
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
    this.assertReceiptOk(user, category, receiptUrl, dto.receiptOverride);

    const tax = this.computeExpenseTax(tenant, dto.amount, dto.taxable);
    const isPetty =
      dto.isPettyCash === true || dto.paymentMethod === 'petty_cash';
    const paymentMethod = isPetty
      ? 'petty_cash'
      : dto.paymentMethod?.trim() || 'cash';

    const saveAsDraft = dto.saveAsDraft === true;
    let status: string;
    let approvedById: string | undefined;
    let approvedAt: Date | undefined;
    if (saveAsDraft) {
      status = 'draft';
    } else {
      const auto = this.shouldAutoApprove(
        user,
        tax.amount,
        tenant.settings,
      );
      status = auto ? 'approved' : 'pending';
      if (auto) {
        approvedById = user.userId;
        approvedAt = new Date();
      }
    }

    const applyPettyDebit = isPetty && status !== 'draft';

    return this.prisma.$transaction(async (tx) => {
      const expenseNumber = await this.nextExpenseNumber(tx, user.tenantId);
      try {
        const created = await tx.expense.create({
          data: {
            tenantId: user.tenantId,
            expenseNumber,
            amount: tax.amount,
            netAmount: tax.netAmount,
            taxAmount: tax.taxAmount,
            taxRatePercent: tax.taxRatePercent,
            taxInclusive: tax.taxInclusive,
            spentAt: new Date(dto.spentAt),
            categoryId: dto.categoryId,
            locationId: dto.locationId,
            paymentMethod,
            payee: dto.payee?.trim() || null,
            reference: dto.reference?.trim() || null,
            notes: dto.notes?.trim() || null,
            isPettyCash: isPetty,
            isReimbursement: dto.isReimbursement ?? false,
            receiptUrl,
            createdById: user.userId,
            idempotencyKey: dto.idempotencyKey?.trim() || null,
            status,
            approvedById,
            approvedAt,
          },
          include: expenseInclude,
        });

        if (applyPettyDebit) {
          await this.debitPettyForExpense(tx, user, created);
        }

        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'expense',
            entityId: created.id,
            action: 'expense.created',
            beforeAfter: {
              after: {
                expenseNumber: created.expenseNumber,
                amount: Number(created.amount),
                status: created.status,
                paymentMethod: created.paymentMethod,
                isPettyCash: created.isPettyCash,
              },
            },
          },
        });

        if (status === 'approved') {
          await this.accounting.postExpense(tx, user, created.id);
        }

        return created;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          dto.idempotencyKey?.trim()
        ) {
          const again = await tx.expense.findFirst({
            where: {
              tenantId: user.tenantId,
              idempotencyKey: dto.idempotencyKey.trim(),
            },
            include: expenseInclude,
          });
          if (again) return { ...again, replayed: true as const };
        }
        throw e;
      }
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateExpenseDto) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { pettyLedger: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status !== 'draft' && row.status !== 'pending') {
      throw new BadRequestException(
        'Only draft or pending expenses can be edited',
      );
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { taxMode: true, taxId: true, settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    let categoryId = row.categoryId;
    let category: {
      id: string;
      receiptRequired: boolean;
      isActive: boolean;
    } | null = null;
    if (dto.categoryId !== undefined) {
      if (dto.categoryId) {
        category = await this.prisma.expenseCategory.findFirst({
          where: { id: dto.categoryId, tenantId: user.tenantId },
          select: { id: true, receiptRequired: true, isActive: true },
        });
        if (!category) throw new NotFoundException('Category not found');
        if (!category.isActive) {
          throw new BadRequestException('Category is inactive');
        }
        categoryId = category.id;
      } else {
        categoryId = null;
      }
    } else if (row.categoryId) {
      category = await this.prisma.expenseCategory.findFirst({
        where: { id: row.categoryId, tenantId: user.tenantId },
        select: { id: true, receiptRequired: true, isActive: true },
      });
    }

    if (dto.locationId !== undefined && dto.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: dto.locationId, tenantId: user.tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    let receiptUrl = row.receiptUrl;
    if (dto.receiptBase64?.trim()) {
      receiptUrl = await saveProductImage(user.tenantId, dto.receiptBase64);
    }

    const tax =
      dto.amount != null || dto.taxable !== undefined
        ? this.computeExpenseTax(
            tenant,
            dto.amount != null ? dto.amount : Number(row.netAmount ?? row.amount),
            dto.taxable,
          )
        : {
            amount: Number(row.amount),
            netAmount: Number(row.netAmount ?? row.amount),
            taxAmount: Number(row.taxAmount),
            taxRatePercent: Number(row.taxRatePercent ?? 0),
            taxInclusive: row.taxInclusive,
          };

    let isPetty = row.isPettyCash;
    if (dto.isPettyCash !== undefined) isPetty = dto.isPettyCash;
    if (dto.paymentMethod === 'petty_cash') isPetty = true;
    if (
      dto.paymentMethod !== undefined &&
      dto.paymentMethod !== 'petty_cash' &&
      dto.isPettyCash !== true
    ) {
      isPetty = false;
    }
    const paymentMethod = isPetty
      ? 'petty_cash'
      : dto.paymentMethod?.trim() ||
        (row.paymentMethod === 'petty_cash' ? 'cash' : row.paymentMethod);

    this.assertReceiptOk(user, category, receiptUrl, dto.receiptOverride);

    const submitDraft =
      dto.submitDraft === true && row.status === 'draft';
    let nextStatus = row.status;
    let approvedById = row.approvedById;
    let approvedAt = row.approvedAt;
    if (submitDraft) {
      const auto = this.shouldAutoApprove(user, tax.amount, tenant.settings);
      nextStatus = auto ? 'approved' : 'pending';
      if (auto) {
        approvedById = user.userId;
        approvedAt = new Date();
      }
    }

    const hadLedger = row.pettyLedger.length > 0;
    const needsPettyDebit =
      isPetty &&
      nextStatus !== 'draft' &&
      !hadLedger &&
      (submitDraft || row.status === 'pending' || nextStatus === 'approved');

    return this.prisma.$transaction(async (tx) => {
      // If switching off petty while a ledger exists, reverse it
      if (!isPetty && hadLedger) {
        await this.reversePettyForExpense(tx, user, row.id, 'expense.update');
      }

      const updated = await tx.expense.update({
        where: { id },
        data: {
          amount: tax.amount,
          netAmount: tax.netAmount,
          taxAmount: tax.taxAmount,
          taxRatePercent: tax.taxRatePercent,
          taxInclusive: tax.taxInclusive,
          ...(dto.spentAt ? { spentAt: new Date(dto.spentAt) } : {}),
          categoryId,
          ...(dto.locationId !== undefined
            ? { locationId: dto.locationId || null }
            : {}),
          paymentMethod,
          ...(dto.payee !== undefined
            ? { payee: dto.payee?.trim() || null }
            : {}),
          ...(dto.reference !== undefined
            ? { reference: dto.reference?.trim() || null }
            : {}),
          ...(dto.notes !== undefined
            ? { notes: dto.notes?.trim() || null }
            : {}),
          isPettyCash: isPetty,
          ...(dto.isReimbursement !== undefined
            ? { isReimbursement: dto.isReimbursement }
            : {}),
          receiptUrl,
          status: nextStatus,
          approvedById,
          approvedAt,
        },
        include: expenseInclude,
      });

      if (needsPettyDebit || (isPetty && !hadLedger && nextStatus !== 'draft')) {
        const stillMissing = await tx.pettyCashLedgerEntry.findFirst({
          where: { tenantId: user.tenantId, expenseId: id },
        });
        if (!stillMissing) {
          await this.debitPettyForExpense(tx, user, updated);
        }
      }

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'expense',
          entityId: id,
          action: 'expense.updated',
          beforeAfter: {
            before: {
              amount: Number(row.amount),
              status: row.status,
              paymentMethod: row.paymentMethod,
            },
            after: {
              amount: Number(updated.amount),
              status: updated.status,
              paymentMethod: updated.paymentMethod,
            },
          },
        },
      });

      return updated;
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
    const updated = await this.prisma.expense.update({
      where: { id },
      data: { receiptUrl },
      select: { id: true, receiptUrl: true },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'expense',
        entityId: id,
        action: 'expense.receipt_uploaded',
        beforeAfter: { after: { receiptUrl } },
      },
    });
    return updated;
  }

  // ─── Approve / reject / void / delete ─────────────────────────────────────

  async approve(user: AuthUser, id: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to approve expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId, status: 'pending' },
      include: { pettyLedger: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException('Pending expense not found');

    return this.prisma.$transaction(async (tx) => {
      if (row.isPettyCash && row.pettyLedger.length === 0) {
        await this.debitPettyForExpense(tx, user, row);
      }
      const updated = await tx.expense.update({
        where: { id },
        data: {
          status: 'approved',
          approvedById: user.userId,
          approvedAt: new Date(),
          rejectReason: null,
        },
        include: expenseInclude,
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'expense',
          entityId: id,
          action: 'expense.approved',
          beforeAfter: {
            before: { status: 'pending' },
            after: { status: 'approved' },
          },
        },
      });
      await this.accounting.postExpense(tx, user, id);
      return updated;
    });
  }

  async reject(user: AuthUser, id: string, reason?: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to reject expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId, status: 'pending' },
      include: { pettyLedger: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException('Pending expense not found');

    return this.prisma.$transaction(async (tx) => {
      if (row.isPettyCash && row.pettyLedger.length > 0) {
        await this.reversePettyForExpense(tx, user, id, 'expense.reject');
      }
      const updated = await tx.expense.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectReason: reason?.trim() || null,
          approvedById: user.userId,
          approvedAt: new Date(),
        },
        include: expenseInclude,
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'expense',
          entityId: id,
          action: 'expense.rejected',
          beforeAfter: {
            before: { status: 'pending' },
            after: { status: 'rejected', reason: reason?.trim() || null },
          },
        },
      });
      return updated;
    });
  }

  async void(user: AuthUser, id: string) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to void expenses');
    }
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { pettyLedger: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status === 'voided') return { ok: true, alreadyVoided: true };

    await this.prisma.$transaction(async (tx) => {
      if (row.isPettyCash && row.pettyLedger.length > 0) {
        await this.reversePettyForExpense(tx, user, id, 'expense.void');
      }
      await tx.expense.update({
        where: { id },
        data: { status: 'voided', voidedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'expense',
          entityId: id,
          action: 'expense.voided',
          beforeAfter: {
            before: { status: row.status },
            after: { status: 'voided' },
          },
        },
      });
    });
    return { ok: true };
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { pettyLedger: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException('Expense not found');
    if (row.status === 'approved') {
      throw new BadRequestException(
        'Approved expenses must be voided, not deleted',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (row.isPettyCash && row.pettyLedger.length > 0) {
        await this.reversePettyForExpense(tx, user, id, 'expense.delete');
      }
      await tx.pettyCashLedgerEntry.deleteMany({
        where: { tenantId: user.tenantId, expenseId: id },
      });
      await tx.expense.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'expense',
          entityId: id,
          action: 'expense.deleted',
          beforeAfter: {
            before: {
              expenseNumber: row.expenseNumber,
              amount: Number(row.amount),
              status: row.status,
            },
          },
        },
      });
    });
    return { ok: true };
  }

  // ─── Petty cash ───────────────────────────────────────────────────────────

  async getPettyCash(user: AuthUser, query: PettyCashQueryDto) {
    const fund = await this.getOrCreateFund(
      user.tenantId,
      query.locationId ?? null,
    );
    return {
      fund: {
        id: fund.id,
        name: fund.name,
        locationId: fund.locationId,
        balance: Number(fund.balance),
        createdAt: fund.createdAt,
        updatedAt: fund.updatedAt,
      },
      balance: Number(fund.balance),
    };
  }

  async getPettyCashLedger(user: AuthUser, query: PettyCashLedgerQueryDto) {
    const fund = await this.getOrCreateFund(
      user.tenantId,
      query.locationId ?? null,
    );
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const entries = await this.prisma.pettyCashLedgerEntry.findMany({
      where: { tenantId: user.tenantId, fundId: fund.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        expense: {
          select: {
            id: true,
            expenseNumber: true,
            amount: true,
            status: true,
          },
        },
      },
    });
    return {
      fundId: fund.id,
      balance: Number(fund.balance),
      items: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        direction: e.direction,
        amount: Number(e.amount),
        balanceAfter: Number(e.balanceAfter),
        expenseId: e.expenseId,
        expense: e.expense,
        reference: e.reference,
        notes: e.notes,
        actorUserId: e.actorUserId,
        createdAt: e.createdAt,
      })),
    };
  }

  async pettyCashOpening(user: AuthUser, dto: PettyCashOpeningDto) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to set petty cash opening');
    }
    const locationId = dto.locationId ?? null;
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: user.tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const fund = await this.getOrCreateFundTx(tx, user.tenantId, locationId);
      const entryCount = await tx.pettyCashLedgerEntry.count({
        where: { fundId: fund.id },
      });
      if (Number(fund.balance) > 0 || entryCount > 0) {
        throw new BadRequestException(
          'Opening balance only allowed when fund balance is 0 and has no ledger entries',
        );
      }
      const amount = Number(dto.amount.toFixed(2));
      const updated = await tx.pettyCashFund.update({
        where: { id: fund.id },
        data: { balance: amount },
      });
      await tx.pettyCashLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          fundId: fund.id,
          kind: 'opening',
          direction: 'credit',
          amount,
          balanceAfter: amount,
          notes: dto.notes?.trim() || null,
          actorUserId: user.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'petty_cash_fund',
          entityId: fund.id,
          action: 'petty_cash.opening',
          beforeAfter: {
            after: { amount, locationId, notes: dto.notes?.trim() || null },
          },
        },
      });
      return {
        fundId: updated.id,
        balance: Number(updated.balance),
        amount,
      };
    });
  }

  async pettyCashReplenish(user: AuthUser, dto: PettyCashReplenishDto) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to replenish petty cash');
    }
    const locationId = dto.locationId ?? null;
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: user.tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const fund = await this.getOrCreateFundTx(tx, user.tenantId, locationId);
      const amount = Number(dto.amount.toFixed(2));
      const nextBal = Number((Number(fund.balance) + amount).toFixed(2));
      const updated = await tx.pettyCashFund.update({
        where: { id: fund.id },
        data: { balance: nextBal },
      });
      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          fundId: fund.id,
          kind: 'replenishment',
          direction: 'credit',
          amount,
          balanceAfter: nextBal,
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          actorUserId: user.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'petty_cash_fund',
          entityId: fund.id,
          action: 'petty_cash.replenish',
          beforeAfter: {
            after: {
              amount,
              balance: nextBal,
              paymentMethod: dto.paymentMethod ?? null,
              reference: dto.reference?.trim() || null,
              ledgerEntryId: entry.id,
            },
          },
        },
      });
      return {
        fundId: updated.id,
        balance: nextBal,
        amount,
        ledgerEntryId: entry.id,
      };
    });
  }

  async pettyCashAdjust(user: AuthUser, dto: PettyCashAdjustDto) {
    if (!this.isExpenseApprover(user)) {
      throw new BadRequestException('Not allowed to adjust petty cash');
    }
    const locationId = dto.locationId ?? null;
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: user.tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const fund = await this.getOrCreateFundTx(tx, user.tenantId, locationId);
      const amount = Number(dto.amount.toFixed(2));
      const bal = Number(fund.balance);
      const nextBal =
        dto.direction === 'credit'
          ? Number((bal + amount).toFixed(2))
          : Number((bal - amount).toFixed(2));
      if (nextBal < -1e-9) {
        throw new BadRequestException('Insufficient petty cash balance');
      }
      const updated = await tx.pettyCashFund.update({
        where: { id: fund.id },
        data: { balance: nextBal },
      });
      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          fundId: fund.id,
          kind: 'adjustment',
          direction: dto.direction,
          amount,
          balanceAfter: nextBal,
          notes: dto.notes.trim(),
          actorUserId: user.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'petty_cash_fund',
          entityId: fund.id,
          action: 'petty_cash.adjust',
          beforeAfter: {
            after: {
              amount,
              direction: dto.direction,
              balance: nextBal,
              notes: dto.notes.trim(),
              ledgerEntryId: entry.id,
            },
          },
        },
      });
      return {
        fundId: updated.id,
        balance: nextBal,
        amount,
        direction: dto.direction,
        ledgerEntryId: entry.id,
      };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private isExpenseApprover(user: AuthUser) {
    return user.roles.some(
      (r) => r === 'admin' || r === 'manager' || r === 'accountant',
    );
  }

  private parseApprovalThreshold(settings: unknown): number {
    const root =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>)
        : {};
    const expenses =
      root.expenses && typeof root.expenses === 'object'
        ? (root.expenses as Record<string, unknown>)
        : {};
    const raw = expenses.approvalThresholdAmount;
    const threshold =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw)
          : 0;
    return Number.isFinite(threshold) ? threshold : 0;
  }

  private shouldAutoApprove(
    user: AuthUser,
    amount: number,
    settings: unknown,
  ): boolean {
    if (this.isExpenseApprover(user)) return true;
    const threshold = this.parseApprovalThreshold(settings);
    if (!Number.isFinite(threshold) || threshold <= 0) return false;
    return amount <= threshold + 1e-9;
  }

  private assertReceiptOk(
    user: AuthUser,
    category: { receiptRequired: boolean } | null,
    receiptUrl: string | null | undefined,
    receiptOverride?: boolean,
  ) {
    if (!category?.receiptRequired) return;
    if (receiptUrl) return;
    if (this.isExpenseApprover(user) && receiptOverride === true) return;
    throw new BadRequestException(
      'Receipt is required for this category (or set receiptOverride as finance approver)',
    );
  }

  private computeExpenseTax(
    tenant: { taxMode: TaxMode; taxId: string | null; settings: unknown },
    inputAmount: number,
    taxableFlag?: boolean,
  ): {
    amount: number;
    netAmount: number;
    taxAmount: number;
    taxRatePercent: number;
    taxInclusive: boolean;
  } {
    const profile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId ?? null,
      settings: tenant.settings,
    });
    const defaultTaxable = tenant.taxMode !== TaxMode.none;
    const taxable = taxableFlag ?? defaultTaxable;

    if (!taxable || profile.taxMode === TaxMode.none || profile.rate <= 0) {
      const amt = Number(inputAmount.toFixed(2));
      return {
        amount: amt,
        netAmount: amt,
        taxAmount: 0,
        taxRatePercent: 0,
        taxInclusive: false,
      };
    }

    const taxed = computeLineTax(profile, { lineGross: inputAmount });
    const net = Number(taxed.lineTotal.toFixed(2));
    const taxAmt = Number(taxed.taxAmount.toFixed(2));
    const amount = profile.inclusive
      ? Number(inputAmount.toFixed(2))
      : Number((net + taxAmt).toFixed(2));

    return {
      amount,
      netAmount: net,
      taxAmount: taxAmt,
      taxRatePercent: Number((profile.rate * 100).toFixed(3)),
      taxInclusive: profile.inclusive,
    };
  }

  private async nextExpenseNumber(tx: PrismaTx, tenantId: string) {
    const year = new Date().getFullYear();
    const prefix = `EXP-${year}-`;
    const count = await tx.expense.count({
      where: {
        tenantId,
        expenseNumber: { startsWith: prefix },
      },
    });
    return `${prefix}${String(count + 1).padStart(5, '0')}`;
  }

  private async getOrCreateFund(tenantId: string, locationId: string | null) {
    return this.getOrCreateFundTx(this.prisma, tenantId, locationId);
  }

  private async getOrCreateFundTx(
    db: PrismaService | PrismaTx,
    tenantId: string,
    locationId: string | null,
  ) {
    if (locationId) {
      const existing = await db.pettyCashFund.findUnique({
        where: {
          tenantId_locationId: { tenantId, locationId },
        },
      });
      if (existing) return existing;
      try {
        return await db.pettyCashFund.create({
          data: { tenantId, locationId, name: 'Petty cash', balance: 0 },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const again = await db.pettyCashFund.findUnique({
            where: {
              tenantId_locationId: { tenantId, locationId },
            },
          });
          if (again) return again;
        }
        throw e;
      }
    }

    // Unique (tenantId, locationId) with null location — use findFirst
    const existing = await db.pettyCashFund.findFirst({
      where: { tenantId, locationId: null },
    });
    if (existing) return existing;
    try {
      return await db.pettyCashFund.create({
        data: {
          tenantId,
          locationId: null,
          name: 'Petty cash',
          balance: 0,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const again = await db.pettyCashFund.findFirst({
          where: { tenantId, locationId: null },
        });
        if (again) return again;
      }
      throw e;
    }
  }

  private async debitPettyForExpense(
    tx: PrismaTx,
    user: AuthUser,
    expense: {
      id: string;
      amount: Prisma.Decimal | number | string;
      locationId: string | null;
      expenseNumber?: string | null;
    },
  ) {
    const amount = Number(Number(expense.amount).toFixed(2));
    const fund = await this.getOrCreateFundTx(
      tx,
      user.tenantId,
      expense.locationId,
    );
    const bal = Number(fund.balance);
    if (bal + 1e-9 < amount) {
      throw new BadRequestException(
        `Insufficient petty cash balance (${bal.toFixed(2)}); need ${amount.toFixed(2)}`,
      );
    }
    const nextBal = Number((bal - amount).toFixed(2));
    await tx.pettyCashFund.update({
      where: { id: fund.id },
      data: { balance: nextBal },
    });
    await tx.pettyCashLedgerEntry.create({
      data: {
        tenantId: user.tenantId,
        fundId: fund.id,
        kind: 'expense',
        direction: 'debit',
        amount,
        balanceAfter: nextBal,
        expenseId: expense.id,
        reference: expense.expenseNumber ?? null,
        actorUserId: user.userId,
      },
    });
  }

  private async reversePettyForExpense(
    tx: PrismaTx,
    user: AuthUser,
    expenseId: string,
    reason: string,
  ) {
    const debits = await tx.pettyCashLedgerEntry.findMany({
      where: {
        tenantId: user.tenantId,
        expenseId,
        kind: 'expense',
        direction: 'debit',
      },
    });
    if (!debits.length) return;

    for (const debit of debits) {
      const already = await tx.pettyCashLedgerEntry.findFirst({
        where: {
          tenantId: user.tenantId,
          fundId: debit.fundId,
          kind: 'adjustment',
          direction: 'credit',
          expenseId,
          notes: { contains: `reverse:${debit.id}` },
        },
      });
      if (already) continue;

      const fund = await tx.pettyCashFund.findFirst({
        where: { id: debit.fundId, tenantId: user.tenantId },
      });
      if (!fund) continue;
      const amount = Number(debit.amount);
      const nextBal = Number((Number(fund.balance) + amount).toFixed(2));
      await tx.pettyCashFund.update({
        where: { id: fund.id },
        data: { balance: nextBal },
      });
      await tx.pettyCashLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          fundId: fund.id,
          kind: 'adjustment',
          direction: 'credit',
          amount,
          balanceAfter: nextBal,
          expenseId,
          notes: `reverse:${debit.id} (${reason})`,
          actorUserId: user.userId,
        },
      });
    }
  }
}
