import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GlAccountType, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { DEFAULT_CHART_TEMPLATE } from './chart-template';
import { D, money2 } from './money';
import type { Tx } from './mapping-resolve';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    user: AuthUser,
    query: {
      page?: number;
      limit?: number;
      q?: string;
      type?: string;
      active?: string;
    },
  ) {
    const { page, limit, skip } = paginate(query.page, query.limit ?? 100);
    const where: Prisma.GlAccountWhereInput = {
      tenantId: user.tenantId,
      ...(query.type ? { type: query.type as GlAccountType } : {}),
      ...(query.active === 'true' ? { isActive: true } : {}),
      ...(query.active === 'false' ? { isActive: false } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
              { category: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.glAccount.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ code: 'asc' }],
        include: {
          parent: { select: { id: true, code: true, name: true } },
          _count: { select: { children: true, lines: true } },
        },
      }),
      this.prisma.glAccount.count({ where }),
    ]);
    return { items, meta: pageMeta(total, page, limit) };
  }

  async tree(user: AuthUser) {
    const rows = await this.prisma.glAccount.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { code: 'asc' },
      include: { _count: { select: { lines: true, children: true } } },
    });
    const byParent = new Map<string | null, typeof rows>();
    for (const r of rows) {
      const k = r.parentId;
      const list = byParent.get(k) ?? [];
      list.push(r);
      byParent.set(k, list);
    }
    const walk = (parentId: string | null): unknown[] =>
      (byParent.get(parentId) ?? []).map((n) => ({
        ...n,
        children: walk(n.id),
      }));
    return walk(null);
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.glAccount.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true, isActive: true } },
        _count: { select: { lines: true } },
      },
    });
    if (!row) throw new NotFoundException('Account not found');
    return row;
  }

  async create(
    user: AuthUser,
    dto: {
      code: string;
      name: string;
      type: GlAccountType;
      subtype?: string;
      category?: string;
      description?: string;
      parentId?: string;
    },
  ) {
    this.assertEdit(user);
    if (dto.parentId) {
      const parent = await this.prisma.glAccount.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent account not found');
      if (parent.type !== dto.type) {
        throw new BadRequestException('Child account type must match parent');
      }
    }
    try {
      return await this.prisma.glAccount.create({
        data: {
          tenantId: user.tenantId,
          code: dto.code.trim(),
          name: dto.name.trim(),
          type: dto.type,
          subtype: dto.subtype?.trim() || null,
          category: dto.category?.trim() || null,
          description: dto.description?.trim() || null,
          parentId: dto.parentId ?? null,
          createdById: user.userId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Account code already exists');
      }
      throw e;
    }
  }

  async update(
    user: AuthUser,
    id: string,
    dto: {
      name?: string;
      subtype?: string;
      category?: string;
      description?: string;
      parentId?: string | null;
      isActive?: boolean;
    },
  ) {
    this.assertEdit(user);
    const row = await this.get(user, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('Account cannot be its own parent');
      const parent = await this.prisma.glAccount.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent account not found');
      if (parent.type !== row.type) {
        throw new BadRequestException('Child account type must match parent');
      }
    }
    return this.prisma.glAccount.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.subtype !== undefined ? { subtype: dto.subtype?.trim() || null } : {}),
        ...(dto.category !== undefined ? { category: dto.category?.trim() || null } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() || null }
          : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async remove(user: AuthUser, id: string) {
    this.assertEdit(user);
    const row = await this.prisma.glAccount.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { _count: { select: { lines: true, children: true, mappings: true } } },
    });
    if (!row) throw new NotFoundException('Account not found');
    if (row._count.lines > 0) {
      throw new BadRequestException(
        'Cannot delete an account used by posted accounting transactions — deactivate it instead',
      );
    }
    if (row._count.children > 0) {
      throw new BadRequestException('Cannot delete an account that has child accounts');
    }
    if (row._count.mappings > 0) {
      throw new BadRequestException(
        'Cannot delete an account that is mapped — clear mappings first or deactivate',
      );
    }
    await this.prisma.glAccount.delete({ where: { id } });
    return { ok: true };
  }

  async seedChart(tx: Tx, tenantId: string, userId: string) {
    const existing = await tx.glAccount.count({ where: { tenantId } });
    if (existing > 0) return { seeded: false, count: existing };

    const idByCode = new Map<string, string>();
    for (const tpl of DEFAULT_CHART_TEMPLATE) {
      const created = await tx.glAccount.create({
        data: {
          tenantId,
          code: tpl.code,
          name: tpl.name,
          type: tpl.type,
          subtype: tpl.subtype,
          category: tpl.category,
          parentId: tpl.parentCode ? idByCode.get(tpl.parentCode) ?? null : null,
          isSystem: true,
          createdById: userId,
        },
      });
      idByCode.set(tpl.code, created.id);
    }
    for (const tpl of DEFAULT_CHART_TEMPLATE) {
      const accountId = idByCode.get(tpl.code);
      if (!accountId || !tpl.mappingKeys?.length) continue;
      for (const key of tpl.mappingKeys) {
        await tx.accountMapping.upsert({
          where: {
            tenantId_mappingKey_scopeKey: {
              tenantId,
              mappingKey: key,
              scopeKey: '*',
            },
          },
          create: {
            tenantId,
            mappingKey: key,
            scopeKey: '*',
            accountId,
            createdById: userId,
          },
          update: { accountId },
        });
      }
    }
    return { seeded: true, count: DEFAULT_CHART_TEMPLATE.length };
  }

  async balances(
    user: AuthUser,
    query: { asOf?: string; locationId?: string },
  ) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    const accounts = await this.prisma.glAccount.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      orderBy: { code: 'asc' },
    });
    const grouped = await this.prisma.journalEntryLine.groupBy({
      by: ['accountId'],
      where: {
        tenantId: user.tenantId,
        journalEntry: {
          status: 'POSTED',
          entryDate: { lte: asOf },
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });
    const byId = new Map(grouped.map((g) => [g.accountId, g]));
    return accounts.map((a) => {
      const s = byId.get(a.id)?._sum;
      const debit = D(s?.debit);
      const credit = D(s?.credit);
      const raw =
        a.type === 'ASSET' || a.type === 'EXPENSE'
          ? debit.sub(credit)
          : credit.sub(debit);
      return {
        ...a,
        debit: money2(debit),
        credit: money2(credit),
        balance: money2(raw),
      };
    });
  }

  private assertEdit(user: AuthUser) {
    if (
      user.roles?.includes('admin') ||
      user.roles?.includes('manager') ||
      user.roles?.includes('accountant') ||
      user.permissions?.includes('*') ||
      user.permissions?.includes('accounting.edit') ||
      user.permissions?.includes('accounting.create')
    ) {
      return;
    }
    throw new ForbiddenException('accounting.edit required');
  }
}
