import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  UpdateAppointmentDto,
} from './dto/appointments.dto';

type AppointmentRow = Prisma.AppointmentGetPayload<{
  include: {
    customer: { select: { id: true; fullName: true; phone: true } };
    location: { select: { id: true; name: true; code: true } };
    assignee: { select: { id: true; fullName: true } };
    order: { select: { id: true; orderNumber: true; status: true } };
  };
}>;

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateAppointmentDto) {
    const locationId = dto.locationId ?? dto.storeId;
    if (!locationId) {
      throw new BadRequestException('locationId (or storeId) is required');
    }
    const type = (dto.type ?? dto.aptType)?.trim();
    if (!type) {
      throw new BadRequestException('type (or aptType) is required');
    }

    await this.assertLocation(user.tenantId, locationId);
    await this.assertCustomer(user.tenantId, dto.customerId);
    if (dto.orderId) {
      await this.assertOrder(user.tenantId, dto.orderId);
    }

    const assigneeId = dto.assigneeId ?? dto.assignedUserId;
    if (assigneeId) {
      await this.assertUser(user.tenantId, assigneeId);
    }

    const notes =
      dto.notes ??
      dto.fittingNotes ??
      (dto.alterationNeeds
        ? `Alterations: ${dto.alterationNeeds}`
        : undefined);

    const row = await this.prisma.appointment.create({
      data: {
        tenantId: user.tenantId,
        locationId,
        customerId: dto.customerId,
        orderId: dto.orderId,
        type,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        assigneeId,
        notes,
        status: AppointmentStatus.scheduled,
        meta: dto.alterationNeeds
          ? { alterationNeeds: dto.alterationNeeds }
          : undefined,
      },
      include: this.defaultInclude(),
    });

    return this.present(row);
  }

  async list(user: AuthUser, query: ListAppointmentsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const locationId = query.locationId ?? query.storeId;

    const where: Prisma.AppointmentWhereInput = {
      tenantId: user.tenantId,
      ...(locationId ? { locationId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            startsAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { startsAt: 'asc' },
        include: this.defaultInclude(),
      }),
      this.prisma.appointment.count({ where }),
    ]);

    return {
      items: items.map((row) => this.present(row)),
      meta: pageMeta(total, page, limit),
    };
  }

  async getById(user: AuthUser, id: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, tenantId: user.tenantId },
      include: this.defaultInclude(),
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }
    return this.present(appointment);
  }

  async update(user: AuthUser, id: string, dto: UpdateAppointmentDto) {
    await this.getById(user, id);

    const assigneeId = dto.assigneeId ?? dto.assignee;
    if (assigneeId) {
      await this.assertUser(user.tenantId, assigneeId);
    }

    const data: Prisma.AppointmentUncheckedUpdateInput = {};
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (assigneeId !== undefined) data.assigneeId = assigneeId;
    if (dto.startsAt !== undefined) data.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) data.endsAt = new Date(dto.endsAt);
    if (dto.status !== undefined) data.status = dto.status;

    const row = await this.prisma.appointment.update({
      where: { id },
      data,
      include: this.defaultInclude(),
    });
    return this.present(row);
  }

  async remove(user: AuthUser, id: string) {
    await this.getById(user, id);
    await this.prisma.appointment.update({
      where: { id },
      data: { status: AppointmentStatus.cancelled },
    });
    return null;
  }

  private defaultInclude() {
    return {
      customer: { select: { id: true, fullName: true, phone: true } },
      location: { select: { id: true, name: true, code: true } },
      assignee: { select: { id: true, fullName: true } },
      order: { select: { id: true, orderNumber: true, status: true } },
    } satisfies Prisma.AppointmentInclude;
  }

  /** FE still reads aptType / store / fittingNotes */
  private present(row: AppointmentRow) {
    return {
      ...row,
      aptType: row.type,
      fittingNotes: row.notes,
      storeId: row.locationId,
      store: row.location,
      assignedUserId: row.assigneeId,
    };
  }

  private async assertLocation(tenantId: string, id: string) {
    const row = await this.prisma.location.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Store / location not found');
  }

  private async assertCustomer(tenantId: string, id: string) {
    const row = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Customer not found');
  }

  private async assertOrder(tenantId: string, id: string) {
    const row = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Order not found');
  }

  private async assertUser(tenantId: string, id: string) {
    const row = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Assignee user not found');
  }
}
