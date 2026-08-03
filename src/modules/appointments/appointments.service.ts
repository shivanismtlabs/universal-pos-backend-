import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  AppointmentStatus,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  UpdateAppointmentDto,
} from './dto/appointments.dto';

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateAppointmentDto) {
    await this.assertStore(user.tenantId, dto.storeId);
    await this.assertCustomer(user.tenantId, dto.customerId);
    if (dto.orderId) {
      await this.assertOrder(user.tenantId, dto.orderId);
    }

    return this.prisma.appointment.create({
      data: {
        tenantId: user.tenantId,
        storeId: dto.storeId,
        customerId: dto.customerId,
        orderId: dto.orderId,
        aptType: dto.aptType,
        startsAt: new Date(dto.startsAt),
        assignedUserId: dto.assignedUserId,
        fittingNotes: dto.fittingNotes,
        alterationNeeds: dto.alterationNeeds,
        status: AppointmentStatus.scheduled,
      },
    });
  }

  async list(user: AuthUser, query: ListAppointmentsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.AppointmentWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { storeId: query.storeId } : {}),
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
        include: {
          customer: { select: { id: true, fullName: true, phone: true } },
          assignee: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.appointment.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  async getById(user: AuthUser, id: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        customer: true,
        store: { select: { id: true, name: true, code: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        assignee: { select: { id: true, fullName: true } },
      },
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }
    return appointment;
  }

  async update(user: AuthUser, id: string, dto: UpdateAppointmentDto) {
    await this.getById(user, id);

    if (dto.assignee) {
      await this.assertUser(user.tenantId, dto.assignee);
    }

    const data: Prisma.AppointmentUncheckedUpdateInput = {};
    if (dto.notes !== undefined) data.fittingNotes = dto.notes;
    if (dto.assignee !== undefined) data.assignedUserId = dto.assignee;
    if (dto.startsAt !== undefined) data.startsAt = new Date(dto.startsAt);
    if (dto.status !== undefined) data.status = dto.status;

    return this.prisma.appointment.update({ where: { id }, data });
  }

  async remove(user: AuthUser, id: string) {
    await this.getById(user, id);
    await this.prisma.appointment.update({
      where: { id },
      data: { status: AppointmentStatus.cancelled },
    });
    return null;
  }

  private async assertStore(tenantId: string, id: string) {
    const row = await this.prisma.store.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Store not found');
  }

  private async assertCustomer(tenantId: string, id: string) {
    const row = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Customer not found');
  }

  private async assertOrder(tenantId: string, id: string) {
    const row = await this.prisma.rentalOrder.findFirst({
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
