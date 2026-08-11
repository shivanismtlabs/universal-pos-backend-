import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasPermission } from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  AssignShiftDto,
  ClockDto,
  CreateShiftDto,
  ListAttendanceQueryDto,
  ListShiftsQueryDto,
  UpdateShiftDto,
} from './dto/iam.dto';

@Injectable()
export class IamAttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async clockIn(user: AuthUser, dto: ClockDto) {
    const open = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
      },
    });
    if (open) {
      throw new BadRequestException('Already clocked in — clock out first');
    }
    return this.prisma.attendanceEntry.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        locationId: dto.locationId ?? user.locationId ?? null,
        clockInAt: new Date(),
        method: dto.method ?? 'manual',
        notes: dto.notes,
      },
    });
  }

  async clockOut(user: AuthUser, dto: ClockDto) {
    const open = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
      },
      orderBy: { clockInAt: 'desc' },
    });
    if (!open) throw new BadRequestException('Not clocked in');
    return this.prisma.attendanceEntry.update({
      where: { id: open.id },
      data: {
        clockOutAt: new Date(),
        notes: dto.notes ?? open.notes,
        method: dto.method ?? open.method,
      },
    });
  }

  async myOpen(user: AuthUser) {
    return this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
      },
    });
  }

  async list(user: AuthUser, query: ListAttendanceQueryDto) {
    const manage = this.canManage(user);
    const where: {
      tenantId: string;
      userId?: string;
      clockInAt?: { gte?: Date; lte?: Date };
    } = { tenantId: user.tenantId };

    if (!manage) {
      where.userId = user.userId;
    } else if (query.userId) {
      where.userId = query.userId;
    }

    if (query.from || query.to) {
      where.clockInAt = {};
      if (query.from) where.clockInAt.gte = new Date(query.from);
      if (query.to) where.clockInAt.lte = new Date(query.to);
    }

    const rows = await this.prisma.attendanceEntry.findMany({
      where,
      orderBy: { clockInAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      fullName: r.user.fullName,
      email: r.user.email,
      locationId: r.locationId,
      clockInAt: r.clockInAt,
      clockOutAt: r.clockOutAt,
      method: r.method,
      notes: r.notes,
      minutes:
        r.clockOutAt != null
          ? Math.round(
              (r.clockOutAt.getTime() - r.clockInAt.getTime()) / 60000,
            )
          : null,
    }));
  }

  private canManage(user: AuthUser) {
    return (
      user.roles.includes('admin') ||
      user.roles.includes('manager') ||
      hasPermission(user.permissions, 'attendance.manage')
    );
  }
}

@Injectable()
export class IamShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  async listTemplates(user: AuthUser) {
    return this.prisma.workShift.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { startTime: 'asc' },
    });
  }

  async createTemplate(user: AuthUser, dto: CreateShiftDto) {
    this.assertManage(user);
    this.validateTimes(dto.startTime, dto.endTime);
    return this.prisma.workShift.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
        code: dto.code?.trim(),
        startTime: dto.startTime,
        endTime: dto.endTime,
        daysOfWeek: dto.daysOfWeek ?? [],
        color: dto.color,
        notes: dto.notes,
        isActive: true,
      },
    });
  }

  async updateTemplate(user: AuthUser, id: string, dto: UpdateShiftDto) {
    this.assertManage(user);
    const row = await this.prisma.workShift.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Shift not found');
    if (dto.startTime && dto.endTime) {
      this.validateTimes(dto.startTime, dto.endTime);
    }
    return this.prisma.workShift.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        code: dto.code?.trim(),
        startTime: dto.startTime,
        endTime: dto.endTime,
        daysOfWeek: dto.daysOfWeek,
        color: dto.color,
        notes: dto.notes,
        isActive: dto.isActive,
      },
    });
  }

  async deleteTemplate(user: AuthUser, id: string) {
    this.assertManage(user);
    const row = await this.prisma.workShift.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Shift not found');
    await this.prisma.shiftAssignment.deleteMany({ where: { shiftId: id } });
    await this.prisma.workShift.delete({ where: { id } });
    return { ok: true };
  }

  async assign(user: AuthUser, dto: AssignShiftDto) {
    this.assertManage(user);
    const shift = await this.prisma.workShift.findFirst({
      where: { id: dto.shiftId, tenantId: user.tenantId },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    const staff = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId: user.tenantId },
    });
    if (!staff) throw new NotFoundException('Staff not found');
    const workDate = new Date(dto.workDate);
    if (Number.isNaN(workDate.getTime())) {
      throw new BadRequestException('Invalid workDate (use YYYY-MM-DD)');
    }
    try {
      return await this.prisma.shiftAssignment.create({
        data: {
          tenantId: user.tenantId,
          shiftId: dto.shiftId,
          userId: dto.userId,
          locationId: dto.locationId ?? staff.primaryLocationId,
          workDate,
          notes: dto.notes,
        },
        include: {
          shift: true,
          user: { select: { id: true, fullName: true, email: true } },
        },
      });
    } catch {
      throw new BadRequestException('Already assigned for that day/shift');
    }
  }

  async listAssignments(user: AuthUser, query: ListShiftsQueryDto) {
    const manage = this.canManage(user);
    const where: {
      tenantId: string;
      userId?: string;
      workDate?: { gte?: Date; lte?: Date };
    } = { tenantId: user.tenantId };

    if (!manage) where.userId = user.userId;
    else if (query.userId) where.userId = query.userId;

    if (query.from || query.to) {
      where.workDate = {};
      if (query.from) where.workDate.gte = new Date(query.from);
      if (query.to) where.workDate.lte = new Date(query.to);
    }

    return this.prisma.shiftAssignment.findMany({
      where,
      orderBy: { workDate: 'asc' },
      take: 300,
      include: {
        shift: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  async removeAssignment(user: AuthUser, id: string) {
    this.assertManage(user);
    const row = await this.prisma.shiftAssignment.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Assignment not found');
    await this.prisma.shiftAssignment.delete({ where: { id } });
    return { ok: true };
  }

  private validateTimes(start: string, end: string) {
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!re.test(start) || !re.test(end)) {
      throw new BadRequestException('Times must be HH:mm');
    }
  }

  private canManage(user: AuthUser) {
    return (
      user.roles.includes('admin') ||
      user.roles.includes('manager') ||
      hasPermission(user.permissions, 'shifts.manage')
    );
  }

  private assertManage(user: AuthUser) {
    if (!this.canManage(user)) {
      throw new ForbiddenException('shifts.manage required');
    }
  }
}
