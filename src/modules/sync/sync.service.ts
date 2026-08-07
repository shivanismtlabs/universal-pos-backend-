import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SyncStatus, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import { PaymentMethod, PaymentType } from '@prisma/client';
import {
  CreateSyncEventDto,
  ListSyncEventsQueryDto,
  ResolveSyncEventDto,
} from './dto/sync.dto';

/**
 * Offline queue sync — accepts FE events keyed by clientEventId.
 * `storeId` from clients is treated as locationId (legacy name).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async createEvent(user: AuthUser, dto: CreateSyncEventDto) {
    const locationId = dto.storeId;
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!location) throw new NotFoundException('Location / store not found');

    const existing = await this.prisma.offlineSyncEvent.findUnique({
      where: {
        tenantId_clientEventId: {
          tenantId: user.tenantId,
          clientEventId: dto.clientEventId,
        },
      },
    });
    if (existing) {
      return this.toClient(existing);
    }

    try {
      const created = await this.prisma.offlineSyncEvent.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          deviceId: dto.deviceId,
          clientEventId: dto.clientEventId,
          eventType: dto.eventType,
          payload: dto.payload as Prisma.InputJsonValue,
          status: SyncStatus.accepted,
        },
      });

      await this.applyEvent(user, created.id, dto);

      const row = await this.prisma.offlineSyncEvent.findUniqueOrThrow({
        where: { id: created.id },
      });
      return this.toClient(row);
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
        if (winner) return this.toClient(winner);
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
          throw new BadRequestException('Invalid cash payment payload');
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
        data: { status: SyncStatus.accepted },
      });
    } catch {
      await this.prisma.offlineSyncEvent.update({
        where: { id: eventId },
        data: { status: SyncStatus.conflict },
      });
    }
  }

  async listEvents(user: AuthUser, query: ListSyncEventsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.OfflineSyncEventWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { locationId: query.storeId } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.offlineSyncEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.offlineSyncEvent.count({ where }),
    ]);

    return {
      items: items.map((row) => this.toClient(row)),
      meta: pageMeta(total, page, limit),
    };
  }

  async resolveEvent(user: AuthUser, id: string, dto: ResolveSyncEventDto) {
    const event = await this.prisma.offlineSyncEvent.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!event) throw new NotFoundException('Sync event not found');

    const row = await this.prisma.offlineSyncEvent.update({
      where: { id },
      data: { status: dto.syncStatus },
    });
    return this.toClient(row);
  }

  private toClient(row: {
    id: string;
    eventType: string;
    status: SyncStatus;
    clientEventId: string;
    createdAt: Date;
    locationId?: string | null;
    deviceId: string;
  }) {
    return {
      id: row.id,
      eventType: row.eventType,
      syncStatus: row.status,
      status: row.status,
      clientEventId: row.clientEventId,
      storeId: row.locationId,
      locationId: row.locationId,
      deviceId: row.deviceId,
      createdAt: row.createdAt,
    };
  }
}
