import { BadRequestException, Injectable } from '@nestjs/common';
import { GlAccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { D, money2 } from './money';
import { parseAccountingSettings } from './settings';

@Injectable()
export class AccountingReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async ledger(
    user: AuthUser,
    query: {
      accountId: string;
      from?: string;
      to?: string;
      locationId?: string;
      customerId?: string;
      supplierId?: string;
      sourceType?: string;
      status?: string;
    },
  ) {
    if (!query.accountId) throw new BadRequestException('accountId is required');
    const account = await this.prisma.glAccount.findFirst({
      where: { id: query.accountId, tenantId: user.tenantId },
    });
    if (!account) throw new BadRequestException('Account not found');

    const from = query.from ? new Date(query.from) : undefined;
    const statusFilter =
      query.status === 'all'
        ? undefined
        : query.status === 'REVERSED'
          ? { status: 'REVERSED' as const }
          : { status: 'POSTED' as const };

    const openingWhere: Prisma.JournalEntryLineWhereInput = {
      tenantId: user.tenantId,
      accountId: query.accountId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      journalEntry: {
        ...(statusFilter ?? { status: 'POSTED' }),
        ...(from ? { entryDate: { lt: from } } : { id: 'never' }),
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      },
    };
    const openingAgg = from
      ? await this.prisma.journalEntryLine.aggregate({
          where: openingWhere,
          _sum: { debit: true, credit: true },
        })
      : { _sum: { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) } };

    const openingRaw = this.signed(account.type, D(openingAgg._sum.debit), D(openingAgg._sum.credit));

    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        tenantId: user.tenantId,
        accountId: query.accountId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        journalEntry: {
          ...(statusFilter ?? { status: 'POSTED' }),
          ...(from || query.to
            ? {
                entryDate: {
                  ...(from ? { gte: from } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        },
      },
      include: {
        journalEntry: {
          select: {
            id: true,
            entryNumber: true,
            entryDate: true,
            description: true,
            sourceType: true,
            sourceId: true,
            status: true,
          },
        },
      },
      orderBy: [{ journalEntry: { entryDate: 'asc' } }, { createdAt: 'asc' }],
    });

    let running = openingRaw;
    const rows = lines.map((l) => {
      running = running.add(this.signed(account.type, D(l.debit), D(l.credit)));
      return {
        id: l.id,
        date: l.journalEntry.entryDate,
        reference: l.journalEntry.entryNumber,
        journalEntryId: l.journalEntry.id,
        sourceType: l.journalEntry.sourceType,
        sourceId: l.journalEntry.sourceId,
        description: l.description || l.journalEntry.description,
        debit: money2(l.debit),
        credit: money2(l.credit),
        balance: money2(running),
        status: l.journalEntry.status,
      };
    });

    return {
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      openingBalance: money2(openingRaw),
      closingBalance: money2(running),
      lines: rows,
    };
  }

  async trialBalance(
    user: AuthUser,
    query: { from?: string; to?: string; locationId?: string },
  ) {
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
          ...(query.from || query.to
            ? {
                entryDate: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });
    const byId = new Map(grouped.map((g) => [g.accountId, g]));
    const rows = accounts
      .map((a) => {
        const s = byId.get(a.id)?._sum;
        return {
          accountId: a.id,
          code: a.code,
          name: a.name,
          type: a.type,
          category: a.category,
          debit: money2(s?.debit),
          credit: money2(s?.credit),
        };
      })
      .filter((r) => !D(r.debit).eq(0) || !D(r.credit).eq(0));

    const totalDebit = rows.reduce((s, r) => s.add(D(r.debit)), new Prisma.Decimal(0));
    const totalCredit = rows.reduce((s, r) => s.add(D(r.credit)), new Prisma.Decimal(0));
    const difference = totalDebit.sub(totalCredit);
    const balanced = difference.abs().lessThan('0.005');
    return {
      rows,
      totalDebit: money2(totalDebit),
      totalCredit: money2(totalCredit),
      difference: money2(difference),
      balanced,
      integrityError: balanced
        ? null
        : 'Trial balance is not balanced — posted journals have debit ≠ credit',
    };
  }

  async profitLoss(
    user: AuthUser,
    query: {
      from?: string;
      to?: string;
      locationId?: string;
      category?: string;
      compare?: string;
    },
  ) {
    const current = await this.pnlPeriod(user, query);
    let prior = null;
    if (query.compare === 'true' && query.from && query.to) {
      const from = new Date(query.from);
      const to = new Date(query.to);
      const span = to.getTime() - from.getTime();
      const priorTo = new Date(from.getTime() - 1);
      const priorFrom = new Date(priorTo.getTime() - span);
      prior = await this.pnlPeriod(user, {
        from: priorFrom.toISOString().slice(0, 10),
        to: priorTo.toISOString().slice(0, 10),
        locationId: query.locationId,
        category: query.category,
      });
    }
    return { current, prior, source: 'posted_journals' };
  }

  async balanceSheet(
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

    const bucket = (subtype: string | null, type: GlAccountType, fallback: string) =>
      subtype || fallback;

    const sections: Record<string, Array<{ code: string; name: string; balance: string }>> = {
      currentAssets: [],
      fixedAssets: [],
      currentLiabilities: [],
      longTermLiabilities: [],
      equity: [],
    };
    let retained = new Prisma.Decimal(0);

    for (const a of accounts) {
      const s = byId.get(a.id)?._sum;
      const bal = this.signed(a.type, D(s?.debit), D(s?.credit));
      if (bal.abs().lessThan('0.005')) continue;
      const row = { code: a.code, name: a.name, balance: money2(bal) };
      if (a.type === 'ASSET') {
        if (a.subtype === 'FIXED_ASSET') sections.fixedAssets.push(row);
        else sections.currentAssets.push(row);
      } else if (a.type === 'LIABILITY') {
        if (a.subtype === 'LONG_TERM_LIABILITY') sections.longTermLiabilities.push(row);
        else sections.currentLiabilities.push(row);
      } else if (a.type === 'EQUITY') {
        sections.equity.push(row);
      } else if (a.type === 'REVENUE' || a.type === 'EXPENSE') {
        retained = retained.add(a.type === 'REVENUE' ? bal : bal.neg());
      }
      void bucket;
    }

    if (!retained.abs().lessThan('0.005')) {
      sections.equity.push({
        code: 'RE',
        name: 'Retained earnings / current profit',
        balance: money2(retained),
      });
    }

    const sum = (rows: Array<{ balance: string }>) =>
      rows.reduce((s, r) => s.add(D(r.balance)), new Prisma.Decimal(0));

    const assets = sum(sections.currentAssets).add(sum(sections.fixedAssets));
    const liabilities = sum(sections.currentLiabilities).add(sum(sections.longTermLiabilities));
    const equity = sum(sections.equity);
    const liabEquity = liabilities.add(equity);
    const difference = assets.sub(liabEquity);
    const balanced = difference.abs().lessThan('0.02');

    return {
      asOf,
      sections,
      totals: {
        assets: money2(assets),
        liabilities: money2(liabilities),
        equity: money2(equity),
        liabilitiesAndEquity: money2(liabEquity),
        difference: money2(difference),
      },
      balanced,
      integrityError: balanced
        ? null
        : 'Balance sheet equation failed: Assets ≠ Liabilities + Equity',
      source: 'posted_journals',
    };
  }

  async gstReport(
    user: AuthUser,
    query: { from?: string; to?: string; locationId?: string },
  ) {
    const where: Prisma.AccountingTaxFactWhereInput = {
      tenantId: user.tenantId,
      journalEntry: { status: 'POSTED' },
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.from || query.to
        ? {
            journalEntry: {
              status: 'POSTED',
              entryDate: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            },
          }
        : {}),
    };
    const facts = await this.prisma.accountingTaxFact.findMany({
      where,
      include: {
        journalEntry: {
          select: { entryNumber: true, entryDate: true, sourceType: true, sourceId: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const sumDir = (dir: string, taxType?: string) =>
      facts
        .filter((f) => f.direction === dir && (!taxType || f.taxType === taxType))
        .reduce((s, f) => s.add(D(f.taxAmount)), new Prisma.Decimal(0));

    const byRate = new Map<string, { taxable: Prisma.Decimal; tax: Prisma.Decimal }>();
    const byHsn = new Map<string, { taxable: Prisma.Decimal; tax: Prisma.Decimal }>();
    const byParty = new Map<string, { taxable: Prisma.Decimal; tax: Prisma.Decimal }>();
    for (const f of facts) {
      const rateKey = `${f.taxType}:${money2(f.taxRate)}`;
      const r = byRate.get(rateKey) ?? { taxable: new Prisma.Decimal(0), tax: new Prisma.Decimal(0) };
      r.taxable = r.taxable.add(D(f.taxableValue));
      r.tax = r.tax.add(D(f.taxAmount));
      byRate.set(rateKey, r);
      const hsn = f.hsnSac || 'UNCLASSIFIED';
      const h = byHsn.get(hsn) ?? { taxable: new Prisma.Decimal(0), tax: new Prisma.Decimal(0) };
      h.taxable = h.taxable.add(D(f.taxableValue));
      h.tax = h.tax.add(D(f.taxAmount));
      byHsn.set(hsn, h);
      const p = f.partyType || 'UNCLASSIFIED';
      const pt = byParty.get(p) ?? { taxable: new Prisma.Decimal(0), tax: new Prisma.Decimal(0) };
      pt.taxable = pt.taxable.add(D(f.taxableValue));
      pt.tax = pt.tax.add(D(f.taxAmount));
      byParty.set(p, pt);
    }

    const output = sumDir('OUTPUT');
    const input = sumDir('INPUT');
    return {
      outputGst: money2(output),
      inputGst: money2(input),
      cgst: money2(sumDir('OUTPUT', 'CGST').add(sumDir('INPUT', 'CGST'))),
      sgst: money2(sumDir('OUTPUT', 'SGST').add(sumDir('INPUT', 'SGST'))),
      igst: money2(sumDir('OUTPUT', 'IGST').add(sumDir('INPUT', 'IGST'))),
      cess: money2(sumDir('OUTPUT', 'CESS').add(sumDir('INPUT', 'CESS'))),
      netPayable: money2(output.sub(input)),
      taxableSales: money2(
        facts
          .filter((f) => f.direction === 'OUTPUT')
          .reduce((s, f) => s.add(D(f.taxableValue)), new Prisma.Decimal(0)),
      ),
      taxablePurchases: money2(
        facts
          .filter((f) => f.direction === 'INPUT')
          .reduce((s, f) => s.add(D(f.taxableValue)), new Prisma.Decimal(0)),
      ),
      rateSummary: [...byRate.entries()].map(([k, v]) => ({
        key: k,
        taxableValue: money2(v.taxable),
        taxAmount: money2(v.tax),
      })),
      hsnSummary: [...byHsn.entries()].map(([hsnSac, v]) => ({
        hsnSac,
        taxableValue: money2(v.taxable),
        taxAmount: money2(v.tax),
      })),
      partySummary: [...byParty.entries()].map(([partyType, v]) => ({
        partyType,
        taxableValue: money2(v.taxable),
        taxAmount: money2(v.tax),
      })),
      creditDebitNotes: facts.filter((f) =>
        ['SALE_RETURN', 'PURCHASE_RETURN', 'REVERSAL'].includes(f.sourceType),
      ).length,
      lines: facts.map((f) => ({
        date: f.journalEntry.entryDate,
        reference: f.journalEntry.entryNumber,
        sourceType: f.sourceType,
        sourceId: f.sourceId,
        direction: f.direction,
        taxType: f.taxType,
        taxRate: money2(f.taxRate),
        taxableValue: money2(f.taxableValue),
        taxAmount: money2(f.taxAmount),
        hsnSac: f.hsnSac,
        placeOfSupply: f.placeOfSupply,
        partyType: f.partyType,
      })),
      source: 'stored_tax_facts',
    };
  }

  async overview(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { settings: true, currencyCode: true },
    });
    const settings = parseAccountingSettings(tenant?.settings, tenant?.currencyCode);
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const pnl = await this.pnlPeriod(user, {
      from: from.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    });
    const bs = await this.balanceSheet(user, {});
    const ar = this.sectionTotal(bs.sections.currentAssets, 'Receivable');
    const ap = this.sectionTotal(bs.sections.currentLiabilities, 'Payable');
    const cash = this.sectionTotal(bs.sections.currentAssets, 'Cash')
      .add(this.sectionTotal(bs.sections.currentAssets, 'Bank'))
      .add(this.sectionTotal(bs.sections.currentAssets, 'UPI'));
    const gst = this.sectionTotal(bs.sections.currentLiabilities, 'GST');
    return {
      settings,
      cards: {
        revenue: pnl.netRevenue,
        expenses: pnl.operatingExpenses,
        netProfit: pnl.netProfit,
        receivables: money2(ar),
        payables: money2(ap),
        cashBank: money2(cash),
        gstPayable: money2(gst),
      },
      pnl,
    };
  }

  private sectionTotal(
    rows: Array<{ name: string; balance: string }>,
    needle: string,
  ) {
    return rows
      .filter((r) => r.name.toLowerCase().includes(needle.toLowerCase()))
      .reduce((s, r) => s.add(D(r.balance)), new Prisma.Decimal(0));
  }

  private async pnlPeriod(
    user: AuthUser,
    query: { from?: string; to?: string; locationId?: string; category?: string },
  ) {
    const accounts = await this.prisma.glAccount.findMany({
      where: {
        tenantId: user.tenantId,
        type: { in: ['REVENUE', 'EXPENSE'] },
        ...(query.category ? { category: query.category } : {}),
      },
    });
    const grouped = await this.prisma.journalEntryLine.groupBy({
      by: ['accountId'],
      where: {
        tenantId: user.tenantId,
        accountId: { in: accounts.map((a) => a.id) },
        journalEntry: {
          status: 'POSTED',
          ...(query.from || query.to
            ? {
                entryDate: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });
    const byId = new Map(grouped.map((g) => [g.accountId, g]));

    let revenue = new Prisma.Decimal(0);
    let returns = new Prisma.Decimal(0);
    let cogs = new Prisma.Decimal(0);
    let opex = new Prisma.Decimal(0);
    const revenueRows: Array<{ code: string; name: string; amount: string }> = [];
    const expenseRows: Array<{ code: string; name: string; amount: string }> = [];

    for (const a of accounts) {
      const s = byId.get(a.id)?._sum;
      const bal = this.signed(a.type, D(s?.debit), D(s?.credit));
      if (bal.abs().lessThan('0.005')) continue;
      if (a.type === 'REVENUE') {
        if (a.subtype === 'CONTRA_REVENUE') {
          returns = returns.add(bal.abs());
        } else {
          revenue = revenue.add(bal);
          revenueRows.push({ code: a.code, name: a.name, amount: money2(bal) });
        }
      } else if (a.subtype === 'COGS') {
        cogs = cogs.add(bal);
        expenseRows.push({ code: a.code, name: a.name, amount: money2(bal) });
      } else {
        opex = opex.add(bal);
        expenseRows.push({ code: a.code, name: a.name, amount: money2(bal) });
      }
    }

    const netRevenue = revenue.sub(returns);
    const grossProfit = netRevenue.sub(cogs);
    const netProfit = grossProfit.sub(opex);
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      revenue: money2(revenue),
      returns: money2(returns),
      netRevenue: money2(netRevenue),
      cogs: money2(cogs),
      grossProfit: money2(grossProfit),
      operatingExpenses: money2(opex),
      netProfit: money2(netProfit),
      revenueRows,
      expenseRows,
    };
  }

  private signed(type: GlAccountType, debit: Prisma.Decimal, credit: Prisma.Decimal) {
    if (type === 'ASSET' || type === 'EXPENSE') return debit.sub(credit);
    return credit.sub(debit);
  }
}
