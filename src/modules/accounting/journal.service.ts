import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JournalStatus, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { JOURNAL_SOURCE } from './constants';
import { resolveAccountId, sourceKey, type Tx } from './mapping-resolve';
import { D, assertDoubleEntry, isZero, money2 } from './money';
import type { DraftLine, TaxFactDraft } from './posting-rules';
import { reverseDraftLines } from './posting-rules';
import { AccountingPeriodsService } from './periods.service';
import { AccountingSyncService } from './integrations/sync.service';

const LINE_INCLUDE = {
  account: { select: { id: true, code: true, name: true, type: true } },
} as const;

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: AccountingPeriodsService,
    private readonly sync: AccountingSyncService,
  ) {}

  async list(
    user: AuthUser,
    query: {
      page?: number;
      limit?: number;
      status?: string;
      sourceType?: string;
      from?: string;
      to?: string;
      locationId?: string;
      q?: string;
    },
  ) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where: Prisma.JournalEntryWhereInput = {
      tenantId: user.tenantId,
      ...(query.status ? { status: query.status as JournalStatus } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.from || query.to
        ? {
            entryDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { entryNumber: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
              { sourceType: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.journalEntry.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          lines: { include: LINE_INCLUDE },
          location: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return { items: items.map((j) => this.serialize(j)), meta: pageMeta(total, page, limit) };
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        lines: { include: LINE_INCLUDE },
        location: { select: { id: true, name: true, code: true } },
        taxFacts: true,
      },
    });
    if (!row) throw new NotFoundException('Journal entry not found');
    return this.serialize(row);
  }

  async createDraft(
    user: AuthUser,
    dto: {
      entryDate: string;
      description?: string;
      locationId?: string;
      lines: Array<{
        accountId: string;
        debit?: number;
        credit?: number;
        customerId?: string;
        supplierId?: string;
        locationId?: string;
        taxId?: string;
        description?: string;
      }>;
    },
  ) {
    this.assertCreate(user);
    const lines = dto.lines.map((l) => ({
      debit: money2(l.debit ?? 0),
      credit: money2(l.credit ?? 0),
    }));
    assertDoubleEntry(lines, 'Journal');
    const date = new Date(dto.entryDate);
    await this.periods.assertOpen(user.tenantId, date);

    return this.prisma.$transaction(async (tx) => {
      const entryNumber = await this.nextNumber(tx, user.tenantId);
      const created = await tx.journalEntry.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId ?? user.locationId ?? null,
          entryNumber,
          entryDate: date,
          sourceType: JOURNAL_SOURCE.MANUAL,
          description: dto.description?.trim() || 'Manual journal',
          status: JournalStatus.DRAFT,
          createdById: user.userId,
          lines: {
            create: dto.lines.map((l) => ({
              tenantId: user.tenantId,
              accountId: l.accountId,
              debit: money2(l.debit ?? 0),
              credit: money2(l.credit ?? 0),
              customerId: l.customerId ?? null,
              supplierId: l.supplierId ?? null,
              locationId: l.locationId ?? dto.locationId ?? user.locationId ?? null,
              taxId: l.taxId ?? null,
              description: l.description ?? null,
            })),
          },
        },
        include: { lines: { include: LINE_INCLUDE } },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'journal_entry',
          entityId: created.id,
          action: 'accounting.journal.created',
          beforeAfter: { entryNumber, status: 'DRAFT' },
        },
      });
      return this.serialize(created);
    });
  }

  async postDraft(user: AuthUser, id: string) {
    this.assertPost(user);
    const row = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!row) throw new NotFoundException('Journal entry not found');
    if (row.status !== JournalStatus.DRAFT) {
      throw new BadRequestException('Only draft journals can be posted');
    }
    assertDoubleEntry(row.lines, 'Journal');
    await this.periods.assertOpen(user.tenantId, row.entryDate);

    const posted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.journalEntry.update({
        where: { id },
        data: {
          status: JournalStatus.POSTED,
          postedAt: new Date(),
          postedById: user.userId,
        },
        include: { lines: { include: LINE_INCLUDE } },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'journal_entry',
          entityId: id,
          action: 'accounting.journal.posted',
          beforeAfter: { entryNumber: row.entryNumber },
        },
      });
      await this.sync.enqueueForJournal(tx, {
        tenantId: user.tenantId,
        journalEntryId: id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
      });
      return updated;
    });
    return this.serialize(posted);
  }

  async reverse(user: AuthUser, id: string, reason?: string) {
    this.assertReverse(user);
    const row = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true, taxFacts: true },
    });
    if (!row) throw new NotFoundException('Journal entry not found');
    if (row.status !== JournalStatus.POSTED) {
      throw new BadRequestException('Only posted journals can be reversed');
    }
    const existing = await this.prisma.journalEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        reversalOfId: id,
        status: { in: [JournalStatus.POSTED, JournalStatus.DRAFT] },
      },
    });
    if (existing) {
      throw new BadRequestException('Journal already reversed');
    }
    await this.periods.assertOpen(user.tenantId, new Date());

    return this.prisma.$transaction(async (tx) => {
      const entryNumber = await this.nextNumber(tx, user.tenantId);
      const reversal = await tx.journalEntry.create({
        data: {
          tenantId: user.tenantId,
          locationId: row.locationId,
          entryNumber,
          entryDate: new Date(),
          sourceType: JOURNAL_SOURCE.REVERSAL,
          sourceId: row.id,
          sourceKey: sourceKey(JOURNAL_SOURCE.REVERSAL, row.id),
          description: reason?.trim()
            ? `Reversal of ${row.entryNumber}: ${reason.trim()}`
            : `Reversal of ${row.entryNumber}`,
          status: JournalStatus.POSTED,
          createdById: user.userId,
          postedById: user.userId,
          postedAt: new Date(),
          reversalOfId: row.id,
          lines: {
            create: row.lines.map((l) => ({
              tenantId: user.tenantId,
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              customerId: l.customerId,
              supplierId: l.supplierId,
              locationId: l.locationId,
              taxId: l.taxId,
              description: l.description
                ? `Reversal: ${l.description}`
                : `Reversal of ${row.entryNumber}`,
            })),
          },
        },
        include: { lines: { include: LINE_INCLUDE } },
      });
      await tx.journalEntry.update({
        where: { id: row.id },
        data: {
          status: JournalStatus.REVERSED,
          reversedAt: new Date(),
          reversedById: user.userId,
        },
      });
      if (row.taxFacts.length) {
        await tx.accountingTaxFact.createMany({
          data: row.taxFacts.map((f) => ({
            tenantId: user.tenantId,
            journalEntryId: reversal.id,
            locationId: f.locationId,
            sourceType: JOURNAL_SOURCE.REVERSAL,
            sourceId: row.id,
            direction: f.direction,
            taxType: f.taxType,
            taxRate: f.taxRate,
            taxableValue: money2(D(f.taxableValue).neg()),
            taxAmount: money2(D(f.taxAmount).neg()),
            hsnSac: f.hsnSac,
            placeOfSupply: f.placeOfSupply,
            partyType: f.partyType,
          })),
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'journal_entry',
          entityId: row.id,
          action: 'accounting.journal.reversed',
          beforeAfter: {
            original: row.entryNumber,
            reversal: reversal.entryNumber,
            reason: reason ?? null,
          },
        },
      });
      await this.sync.enqueueForJournal(tx, {
        tenantId: user.tenantId,
        journalEntryId: reversal.id,
        sourceType: JOURNAL_SOURCE.REVERSAL,
        sourceId: row.id,
      });
      return this.serialize(reversal);
    });
  }

  async deleteDraft(user: AuthUser, id: string) {
    this.assertCreate(user);
    const row = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Journal entry not found');
    if (row.status !== JournalStatus.DRAFT) {
      throw new BadRequestException(
        'Posted journal entries cannot be deleted — reverse them instead',
      );
    }
    await this.prisma.journalEntry.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Create + post an automatic journal inside an existing POS transaction.
   * Idempotent on sourceKey.
   */
  async postAutomatic(
    tx: Tx,
    args: {
      tenantId: string;
      userId: string;
      locationId?: string | null;
      entryDate: Date;
      sourceType: string;
      sourceId: string;
      sourceKey?: string;
      description: string;
      lines: DraftLine[];
      taxFacts?: TaxFactDraft[];
      meta?: Record<string, unknown>;
    },
  ) {
    const key = args.sourceKey ?? sourceKey(args.sourceType, args.sourceId);
    const existing = await tx.journalEntry.findFirst({
      where: { tenantId: args.tenantId, sourceKey: key },
    });
    if (existing) return existing;

    const balanced = args.lines.filter(
      (l) => !isZero(l.debit) || !isZero(l.credit),
    );
    assertDoubleEntry(balanced, args.description);

    await this.periods.assertOpen(args.tenantId, args.entryDate, tx);

    const resolved = [];
    for (const line of balanced) {
      let accountId: string;
      try {
        accountId = await resolveAccountId(
          tx,
          args.tenantId,
          line.mappingKey,
          line.locationId ?? args.locationId,
        );
      } catch (e) {
        throw new BadRequestException(
          e instanceof Error ? e.message : 'Account mapping missing',
        );
      }
      resolved.push({
        tenantId: args.tenantId,
        accountId,
        debit: money2(line.debit),
        credit: money2(line.credit),
        customerId: line.customerId ?? null,
        supplierId: line.supplierId ?? null,
        locationId: line.locationId ?? args.locationId ?? null,
        taxId: line.taxId ?? null,
        description: line.description ?? null,
      });
    }

    const entryNumber = await this.nextNumber(tx, args.tenantId);
    const created = await tx.journalEntry.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId ?? null,
        entryNumber,
        entryDate: args.entryDate,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        sourceKey: key,
        description: args.description,
        status: JournalStatus.POSTED,
        createdById: args.userId,
        postedById: args.userId,
        postedAt: new Date(),
        meta: (args.meta ?? {}) as Prisma.InputJsonValue,
        lines: { create: resolved },
      },
    });

    if (args.taxFacts?.length) {
      await tx.accountingTaxFact.createMany({
        data: args.taxFacts.map((f) => ({
          tenantId: args.tenantId,
          journalEntryId: created.id,
          locationId: args.locationId ?? null,
          sourceType: args.sourceType,
          sourceId: args.sourceId,
          direction: f.direction,
          taxType: f.taxType,
          taxRate: f.taxRate,
          taxableValue: money2(f.taxableValue),
          taxAmount: money2(f.taxAmount),
          hsnSac: f.hsnSac ?? null,
          placeOfSupply: f.placeOfSupply ?? null,
          partyType: f.partyType ?? null,
        })),
      });
    }

    await tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        entityType: 'journal_entry',
        entityId: created.id,
        action: 'accounting.journal.auto_posted',
        beforeAfter: {
          entryNumber,
          sourceType: args.sourceType,
          sourceId: args.sourceId,
        },
      },
    });

    await this.sync.enqueueForJournal(tx, {
      tenantId: args.tenantId,
      journalEntryId: created.id,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    });

    return created;
  }

  async nextNumber(tx: Tx, tenantId: string) {
    const count = await tx.journalEntry.count({ where: { tenantId } });
    return `JE-${String(count + 1).padStart(6, '0')}`;
  }

  serialize(row: {
    id: string;
    entryNumber: string;
    entryDate: Date;
    sourceType: string;
    sourceId: string | null;
    description: string | null;
    status: JournalStatus;
    postedAt: Date | null;
    reversedAt: Date | null;
    reversalOfId: string | null;
    locationId: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    lines?: Array<{
      id: string;
      accountId: string;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
      customerId: string | null;
      supplierId: string | null;
      locationId: string | null;
      taxId: string | null;
      description: string | null;
      account?: { id: string; code: string; name: string; type: string };
    }>;
    taxFacts?: unknown;
    location?: { id: string; name: string; code: string } | null;
  }) {
    const debit = (row.lines ?? []).reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
    const credit = (row.lines ?? []).reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
    return {
      ...row,
      debitTotal: money2(debit),
      creditTotal: money2(credit),
      balanced: debit.eq(credit),
      lines: (row.lines ?? []).map((l) => ({
        ...l,
        debit: money2(l.debit),
        credit: money2(l.credit),
      })),
    };
  }

  private assertCreate(user: AuthUser) {
    if (!this.has(user, ['accounting.create', 'accounting.edit', 'accounting.post'])) {
      throw new ForbiddenException('accounting.create required');
    }
  }
  private assertPost(user: AuthUser) {
    if (!this.has(user, ['accounting.post'])) {
      throw new ForbiddenException('accounting.post required');
    }
  }
  private assertReverse(user: AuthUser) {
    if (!this.has(user, ['accounting.reverse'])) {
      throw new ForbiddenException('accounting.reverse required');
    }
  }
  private has(user: AuthUser, codes: string[]) {
    if (user.roles?.includes('admin') || user.permissions?.includes('*')) return true;
    return codes.some((c) => user.permissions?.includes(c) || user.roles?.includes('accountant') || user.roles?.includes('manager'));
  }
}

export { reverseDraftLines };
