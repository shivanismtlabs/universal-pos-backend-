import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, PaymentType, Prisma, SyncStatus } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import {
  CreateSyncEventDto,
  ListSyncEventsQueryDto,
  ResolveSyncEventDto,
} from './dto/sync.dto';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async createEvent(user: AuthUser, dto: CreateSyncEventDto) {
    const store = await this.prisma.store.findFirst({
      where: { id: dto.storeId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    const existing = await this.prisma.offlineSyncEvent.findUnique({
      where: {
        tenantId_clientEventId: {
          tenantId: user.tenantId,
          clientEventId: dto.clientEventId,
        },
      },
    });
    if (existing) {
      return existing;
    }

    try {
      const created = await this.prisma.offlineSyncEvent.create({
        data: {
          tenantId: user.tenantId,
          storeId: dto.storeId,
          deviceId: dto.deviceId,
          clientEventId: dto.clientEventId,
          eventType: dto.eventType,
          payload: dto.payload as Prisma.InputJsonValue,
          syncStatus: SyncStatus.accepted,
        },
      });

      await this.applyEvent(user, created.id, dto);

      return this.prisma.offlineSyncEvent.findUniqueOrThrow({
        where: { id: created.id },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.offlineSyncEvent.findUnique({
          where: {
            tenantId_clientEventId: {
              tenantId: user.tenantId,
              clientEventId: dto.clientEventId,
            },
          },
        });
        if (winner) return winner;
      }
      throwIfUnique(e, 'Duplicate sync event');
    }
  }

  private async applyEvent(
    user: AuthUser,
    eventId: string,
    dto: CreateSyncEventDto,
  ) {
    try {
      if (dto.eventType === 'pos.cash_payment') {
        const payload = dto.payload as {
          orderId?: string;
          amount?: number;
          method?: string;
          type?: string;
        };
        if (!payload.orderId || !payload.amount) {
          throw new Error('Invalid cash payment payload');
        }
        await this.paymentsService.create(user, {
          orderId: payload.orderId,
          amount: Number(payload.amount),
          method: (payload.method as PaymentMethod) || PaymentMethod.cash,
          type: (payload.type as PaymentType) || PaymentType.payment,
          idempotencyKey: `offline:${dto.clientEventId}`,
        });
      }

      await this.prisma.offlineSyncEvent.update({
        where: { id: eventId },
        data: { syncStatus: SyncStatus.accepted },
      });
    } catch {
      await this.prisma.offlineSyncEvent.update({
        where: { id: eventId },
        data: { syncStatus: SyncStatus.conflict },
      });
    }
  }

  async listEvents(user: AuthUser, query: ListSyncEventsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.OfflineSyncEventWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.offlineSyncEvent.findMany({
        where,
        orderBy: { syncedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.offlineSyncEvent.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  async resolveEvent(user: AuthUser, id: string, dto: ResolveSyncEventDto) {
    const event = await this.prisma.offlineSyncEvent.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!event) throw new NotFoundException('Sync event not found');

    return this.prisma.offlineSyncEvent.update({
      where: { id },
      data: { syncStatus: dto.syncStatus },
    });
  }
}
