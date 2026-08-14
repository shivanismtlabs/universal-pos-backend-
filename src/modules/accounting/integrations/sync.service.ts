import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationSyncStatus, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../../common/dto/pagination.dto';
import { PrismaService } from '../../../database/database.module';
import type { AuthUser } from '../../auth/types';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '../constants';
import { money2 } from '../money';
import type { Tx } from '../mapping-resolve';
import { QuickBooksAdapter } from './quickbooks.adapter';
import { TallyAdapter } from './tally.adapter';
import { IntegrationTokenService } from './tokens';
import { ZohoBooksAdapter } from './zoho-books.adapter';
import type { AccountingIntegrationAdapter } from './adapter';

@Injectable()
export class AccountingSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: IntegrationTokenService,
    private readonly tally: TallyAdapter,
    private readonly quickbooks: QuickBooksAdapter,
    private readonly zoho: ZohoBooksAdapter,
  ) {}

  adapter(provider: string): AccountingIntegrationAdapter {
    const p = provider.toUpperCase();
    if (p === 'TALLY') return this.tally;
    if (p === 'QUICKBOOKS') return this.quickbooks;
    if (p === 'ZOHO_BOOKS') return this.zoho;
    throw new BadRequestException(`Unknown provider ${provider}`);
  }

  async listConnections(user: AuthUser) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { tenantId: user.tenantId },
    });
    const by = new Map(rows.map((r) => [r.provider, r]));
    return INTEGRATION_PROVIDERS.map((provider) => {
      const row = by.get(provider);
      return {
        provider,
        status: row?.status ?? 'disconnected',
        externalOrgId: row?.externalOrgId ?? null,
        lastTestedAt: row?.lastTestedAt ?? null,
        lastSyncedAt: row?.lastSyncedAt ?? null,
        config: row ? this.tokens.publicConfig(this.tokens.decrypt(row.configEnc)) : {},
        id: row?.id ?? null,
      };
    });
  }

  async connect(
    user: AuthUser,
    provider: string,
    config: Record<string, unknown>,
  ) {
    this.assertManage(user);
    const p = this.norm(provider);
    const adapter = this.adapter(p);
    const existing = await this.prisma.integrationConnection.findUnique({
      where: { tenantId_provider: { tenantId: user.tenantId, provider: p } },
    });
    const prev = this.tokens.decrypt(existing?.configEnc);
    const merged = { ...prev, ...config };
    const result = await adapter.connect({ tenantId: user.tenantId, config: merged });
    const row = await this.prisma.integrationConnection.upsert({
      where: { tenantId_provider: { tenantId: user.tenantId, provider: p } },
      create: {
        tenantId: user.tenantId,
        provider: p,
        status: result.status,
        configEnc: this.tokens.encrypt(merged),
        externalOrgId: result.externalOrgId || null,
        createdById: user.userId,
      },
      update: {
        status: result.status,
        configEnc: this.tokens.encrypt(merged),
        externalOrgId: result.externalOrgId || existing?.externalOrgId || null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'integration_connection',
        entityId: row.id,
        action: 'accounting.integration.connected',
        beforeAfter: { provider: p, status: result.status },
      },
    });
    return this.publicConnection(row);
  }

  async disconnect(user: AuthUser, provider: string) {
    this.assertManage(user);
    const p = this.norm(provider);
    const row = await this.prisma.integrationConnection.findUnique({
      where: { tenantId_provider: { tenantId: user.tenantId, provider: p } },
    });
    if (!row) return { ok: true };
    await this.adapter(p).disconnect({
      tenantId: user.tenantId,
      config: this.tokens.decrypt(row.configEnc),
    });
    await this.prisma.integrationConnection.update({
      where: { id: row.id },
      data: { status: 'disconnected', configEnc: null, externalOrgId: null },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'integration_connection',
        entityId: row.id,
        action: 'accounting.integration.disconnected',
        beforeAfter: { provider: p },
      },
    });
    return { ok: true };
  }

  async test(user: AuthUser, provider: string) {
    const p = this.norm(provider);
    const row = await this.requireConnection(user.tenantId, p);
    const result = await this.adapter(p).testConnection({
      tenantId: user.tenantId,
      config: this.tokens.decrypt(row.configEnc),
    });
    await this.prisma.integrationConnection.update({
      where: { id: row.id },
      data: {
        lastTestedAt: new Date(),
        status: result.ok ? 'connected' : 'error',
      },
    });
    return result;
  }

  async mappings(user: AuthUser, provider: string) {
    const p = this.norm(provider);
    return this.prisma.integrationExternalMap.findMany({
      where: { tenantId: user.tenantId, provider: p },
      include: { account: { select: { id: true, code: true, name: true } } },
      orderBy: [{ entityType: 'asc' }, { localId: 'asc' }],
    });
  }

  async upsertMapping(
    user: AuthUser,
    provider: string,
    dto: {
      entityType: string;
      localId: string;
      externalId: string;
      externalName?: string;
      accountId?: string;
    },
  ) {
    this.assertManage(user);
    const p = this.norm(provider);
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { tenantId_provider: { tenantId: user.tenantId, provider: p } },
    });
    return this.prisma.integrationExternalMap.upsert({
      where: {
        tenantId_provider_entityType_localId: {
          tenantId: user.tenantId,
          provider: p,
          entityType: dto.entityType,
          localId: dto.localId,
        },
      },
      create: {
        tenantId: user.tenantId,
        connectionId: conn?.id ?? null,
        provider: p,
        entityType: dto.entityType,
        localId: dto.localId,
        externalId: dto.externalId,
        externalName: dto.externalName ?? null,
        accountId: dto.accountId ?? null,
        status: 'mapped',
        lastSyncedAt: new Date(),
      },
      update: {
        externalId: dto.externalId,
        externalName: dto.externalName ?? null,
        accountId: dto.accountId ?? null,
        status: 'mapped',
        lastSyncedAt: new Date(),
      },
    });
  }

  async logs(
    user: AuthUser,
    provider: string,
    query: { page?: number; limit?: number },
  ) {
    const p = this.norm(provider);
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where = { tenantId: user.tenantId, provider: p };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.integrationSyncLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.integrationSyncLog.count({ where }),
    ]);
    return { items, meta: pageMeta(total, page, limit) };
  }

  /**
   * Enqueue after the journal is committed (same DB tx, processed later).
   */
  async enqueueForJournal(
    tx: Tx,
    args: {
      tenantId: string;
      journalEntryId: string;
      sourceType: string;
      sourceId: string | null;
    },
  ) {
    const connections = await tx.integrationConnection.findMany({
      where: { tenantId: args.tenantId, status: 'connected' },
    });
    for (const conn of connections) {
      const localId = args.sourceId ?? args.journalEntryId;
      const idempotencyKey = `${args.tenantId}:${conn.provider}:journal:${args.journalEntryId}`;
      await tx.integrationSyncJob.upsert({
        where: {
          tenantId_provider_entityType_localEntityId_operation: {
            tenantId: args.tenantId,
            provider: conn.provider,
            entityType: 'journal',
            localEntityId: args.journalEntryId,
            operation: 'create',
          },
        },
        create: {
          tenantId: args.tenantId,
          connectionId: conn.id,
          provider: conn.provider,
          entityType: 'journal',
          localEntityId: args.journalEntryId,
          journalEntryId: args.journalEntryId,
          operation: 'create',
          status: IntegrationSyncStatus.PENDING,
          idempotencyKey,
        },
        update: {},
      });
      void localId;
    }
  }

  async triggerSync(user: AuthUser, provider: string) {
    this.assertSync(user);
    const p = this.norm(provider);
    await this.requireConnection(user.tenantId, p);
    const processed = await this.processPending(user.tenantId, p);
    return { processed };
  }

  async exportTally(
    user: AuthUser,
    query: { from: string; to: string },
  ) {
    this.assertSync(user);
    const conn = await this.requireConnection(user.tenantId, 'TALLY');
    const journals = await this.prisma.journalEntry.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'POSTED',
        entryDate: { gte: new Date(query.from), lte: new Date(query.to) },
      },
      include: {
        lines: { include: { account: { select: { code: true, name: true } } } },
      },
      orderBy: { entryDate: 'asc' },
    });
    const xmlParts = [];
    for (const j of journals) {
      const existing = await this.prisma.integrationExternalMap.findUnique({
        where: {
          tenantId_provider_entityType_localId: {
            tenantId: user.tenantId,
            provider: 'TALLY',
            entityType: 'journal',
            localId: j.id,
          },
        },
      });
      const result = await this.tally.syncJournalEntries(
        { tenantId: user.tenantId, config: this.tokens.decrypt(conn.configEnc) },
        {
          localId: j.id,
          idempotencyKey: `${user.tenantId}:TALLY:journal:${j.id}`,
          description: j.description ?? j.entryNumber,
          entryDate: j.entryDate.toISOString().slice(0, 10),
          lines: j.lines.map((l) => ({
            accountCode: l.account.code,
            debit: money2(l.debit),
            credit: money2(l.credit),
            description: l.description ?? undefined,
          })),
        },
      );
      if (!result.ok) {
        await this.writeLog({
          tenantId: user.tenantId,
          connectionId: conn.id,
          provider: 'TALLY',
          entityType: 'journal',
          localEntityId: j.id,
          operation: 'export',
          status: 'FAILED',
          errorMessage: result.error ?? 'export failed',
        });
        continue;
      }
      xmlParts.push({ xml: result.payload?.xml });
      if (!existing && result.externalId) {
        await this.prisma.integrationExternalMap.create({
          data: {
            tenantId: user.tenantId,
            connectionId: conn.id,
            provider: 'TALLY',
            entityType: 'journal',
            localId: j.id,
            externalId: result.externalId,
            status: 'synced',
            lastSyncedAt: new Date(),
          },
        });
      }
    }
    const bundle = await this.tally.exportRange(
      { tenantId: user.tenantId, config: this.tokens.decrypt(conn.configEnc) },
      { from: query.from, to: query.to, journals: xmlParts },
    );
    await this.writeLog({
      tenantId: user.tenantId,
      connectionId: conn.id,
      provider: 'TALLY',
      entityType: 'export',
      operation: 'export',
      status: bundle.ok ? 'SYNCED' : 'FAILED',
      requestMeta: {
        from: query.from,
        to: query.to,
        count: journals.length,
        format: 'xml',
      },
      errorMessage: bundle.error,
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'integration_connection',
        entityId: conn.id,
        action: 'accounting.export',
        beforeAfter: { provider: 'TALLY', from: query.from, to: query.to, count: journals.length },
      },
    });
    if (!bundle.ok) throw new BadRequestException(bundle.error || 'Tally export failed');
    return bundle;
  }

  async processPending(tenantId: string, provider?: string) {
    const jobs = await this.prisma.integrationSyncJob.findMany({
      where: {
        tenantId,
        ...(provider ? { provider } : {}),
        status: {
          in: [
            IntegrationSyncStatus.PENDING,
            IntegrationSyncStatus.FAILED,
            IntegrationSyncStatus.RETRYING,
          ],
        },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    let n = 0;
    for (const job of jobs) {
      await this.processJob(job.id);
      n += 1;
    }
    return n;
  }

  async processJob(jobId: string) {
    const job = await this.prisma.integrationSyncJob.findFirst({
      where: { id: jobId },
      include: { journalEntry: { include: { lines: { include: { account: true } } } } },
    });
    if (!job) return;
    const map = await this.prisma.integrationExternalMap.findUnique({
      where: {
        tenantId_provider_entityType_localId: {
          tenantId: job.tenantId,
          provider: job.provider,
          entityType: job.entityType,
          localId: job.localEntityId,
        },
      },
    });
    if (map?.externalId) {
      await this.prisma.integrationSyncJob.update({
        where: { id: job.id },
        data: {
          status: IntegrationSyncStatus.SYNCED,
          syncedAt: map.lastSyncedAt ?? new Date(),
          errorMessage: null,
        },
      });
      return;
    }

    await this.prisma.integrationSyncJob.update({
      where: { id: job.id },
      data: {
        status: IntegrationSyncStatus.PROCESSING,
        lastAttemptAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });

    const conn = await this.prisma.integrationConnection.findUnique({
      where: {
        tenantId_provider: { tenantId: job.tenantId, provider: job.provider },
      },
    });
    if (!conn || conn.status !== 'connected') {
      await this.failJob(job, 'Provider is not connected');
      return;
    }

    try {
      const adapter = this.adapter(job.provider);
      const je = job.journalEntry;
      if (!je || !adapter.syncJournalEntries) {
        await this.failJob(job, 'Nothing to sync');
        return;
      }
      const result = await adapter.syncJournalEntries(
        { tenantId: job.tenantId, config: this.tokens.decrypt(conn.configEnc) },
        {
          localId: je.id,
          idempotencyKey: job.idempotencyKey,
          description: je.description ?? je.entryNumber,
          entryDate: je.entryDate.toISOString().slice(0, 10),
          lines: je.lines.map((l) => ({
            accountCode: l.account.code,
            debit: money2(l.debit),
            credit: money2(l.credit),
            description: l.description ?? undefined,
          })),
        },
      );
      if (!result.ok) {
        await this.failJob(job, result.error || 'sync failed');
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.integrationExternalMap.upsert({
          where: {
            tenantId_provider_entityType_localId: {
              tenantId: job.tenantId,
              provider: job.provider,
              entityType: job.entityType,
              localId: job.localEntityId,
            },
          },
          create: {
            tenantId: job.tenantId,
            connectionId: conn.id,
            provider: job.provider,
            entityType: job.entityType,
            localId: job.localEntityId,
            externalId: result.externalId || job.idempotencyKey,
            status: 'synced',
            lastSyncedAt: new Date(),
          },
          update: {
            externalId: result.externalId || job.idempotencyKey,
            status: 'synced',
            lastSyncedAt: new Date(),
          },
        });
        await tx.integrationSyncJob.update({
          where: { id: job.id },
          data: {
            status: IntegrationSyncStatus.SYNCED,
            syncedAt: new Date(),
            errorMessage: null,
          },
        });
        await tx.integrationSyncLog.create({
          data: {
            tenantId: job.tenantId,
            connectionId: conn.id,
            provider: job.provider,
            entityType: job.entityType,
            localEntityId: job.localEntityId,
            externalEntityId: result.externalId ?? null,
            operation: job.operation,
            status: 'SYNCED',
            requestMeta: (result.payload ?? { idempotencyKey: job.idempotencyKey }) as Prisma.InputJsonValue,
            attemptCount: job.attemptCount + 1,
            lastAttemptAt: new Date(),
            syncedAt: new Date(),
          },
        });
        await tx.integrationConnection.update({
          where: { id: conn.id },
          data: { lastSyncedAt: new Date() },
        });
      });
    } catch (err) {
      await this.failJob(job, err instanceof Error ? err.message : 'sync failed');
    }
  }

  private async failJob(
    job: { id: string; tenantId: string; provider: string; entityType: string; localEntityId: string; operation: string; attemptCount: number; connectionId: string | null },
    message: string,
  ) {
    const retry = job.attemptCount + 1 < 8;
    await this.prisma.integrationSyncJob.update({
      where: { id: job.id },
      data: {
        status: retry ? IntegrationSyncStatus.RETRYING : IntegrationSyncStatus.FAILED,
        errorMessage: message,
        nextAttemptAt: retry
          ? new Date(Date.now() + Math.min(30 * 60 * 1000, 2 ** Math.min(job.attemptCount, 6) * 1000))
          : null,
      },
    });
    await this.writeLog({
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      provider: job.provider,
      entityType: job.entityType,
      localEntityId: job.localEntityId,
      operation: job.operation,
      status: retry ? 'RETRYING' : 'FAILED',
      errorMessage: message,
      attemptCount: job.attemptCount + 1,
    });
  }

  private async writeLog(row: {
    tenantId: string;
    connectionId?: string | null;
    provider: string;
    entityType: string;
    localEntityId?: string | null;
    operation: string;
    status: string;
    requestMeta?: Prisma.InputJsonValue;
    errorMessage?: string | null;
    attemptCount?: number;
  }) {
    await this.prisma.integrationSyncLog.create({
      data: {
        tenantId: row.tenantId,
        connectionId: row.connectionId ?? null,
        provider: row.provider,
        entityType: row.entityType,
        localEntityId: row.localEntityId ?? null,
        operation: row.operation,
        status: row.status,
        requestMeta: row.requestMeta,
        errorMessage: row.errorMessage ?? null,
        attemptCount: row.attemptCount ?? 1,
        lastAttemptAt: new Date(),
        syncedAt: row.status === 'SYNCED' ? new Date() : null,
      },
    });
  }

  private publicConnection(row: {
    id: string;
    provider: string;
    status: string;
    externalOrgId: string | null;
    lastTestedAt: Date | null;
    lastSyncedAt: Date | null;
    configEnc: string | null;
  }) {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      externalOrgId: row.externalOrgId,
      lastTestedAt: row.lastTestedAt,
      lastSyncedAt: row.lastSyncedAt,
      config: this.tokens.publicConfig(this.tokens.decrypt(row.configEnc)),
    };
  }

  private async requireConnection(tenantId: string, provider: string) {
    const row = await this.prisma.integrationConnection.findUnique({
      where: { tenantId_provider: { tenantId, provider } },
    });
    if (!row) throw new NotFoundException(`${provider} is not configured`);
    return row;
  }

  private norm(provider: string): IntegrationProvider {
    const p = provider.toUpperCase().replace(/-/g, '_');
    if (p === 'ZOHO' || p === 'ZOHOBOOKS') return 'ZOHO_BOOKS';
    if (!INTEGRATION_PROVIDERS.includes(p as IntegrationProvider)) {
      throw new BadRequestException(`Unknown provider ${provider}`);
    }
    return p as IntegrationProvider;
  }

  private assertManage(user: AuthUser) {
    if (
      user.roles?.includes('admin') ||
      user.roles?.includes('manager') ||
      user.roles?.includes('accountant') ||
      user.permissions?.includes('*') ||
      user.permissions?.includes('accounting.integrations.manage')
    ) {
      return;
    }
    throw new ForbiddenException('accounting.integrations.manage required');
  }

  private assertSync(user: AuthUser) {
    if (
      user.roles?.includes('admin') ||
      user.roles?.includes('manager') ||
      user.roles?.includes('accountant') ||
      user.permissions?.includes('*') ||
      user.permissions?.includes('accounting.sync') ||
      user.permissions?.includes('accounting.export') ||
      user.permissions?.includes('accounting.integrations.manage')
    ) {
      return;
    }
    throw new ForbiddenException('accounting.sync required');
  }
}
