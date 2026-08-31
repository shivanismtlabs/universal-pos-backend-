import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hasPermission } from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  AssignShiftDto,
  ClockDto,
  CreateAttendanceDto,
  CreateShiftDto,
  ListAttendanceQueryDto,
  ListShiftsQueryDto,
  UpdateAttendanceDto,
  UpdateShiftDto,
} from './dto/iam.dto';

const NO_TIME_STATUSES = new Set([
  'absent',
  'leave',
  'holiday',
  'off_day',
]);

function parseWorkDate(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new BadRequestException('workDate must be YYYY-MM-DD');
  }
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Invalid workDate');
  }
  return d;
}

function combineDateTime(ymd: string, hm: string): Date {
  const d = new Date(`${ymd}T${hm}:00`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid time ${hm}`);
  }
  return d;
}

function ymdFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return ymdFromDate(new Date());
}

function calcWorkedMinutes(
  clockInAt: Date | null | undefined,
  clockOutAt: Date | null | undefined,
  breakMinutes: number,
  asOf: Date = new Date(),
): number | null {
  if (!clockInAt) return null;
  const end = clockOutAt ?? asOf;
  if (end.getTime() < clockInAt.getTime()) return null;
  const raw = Math.round(
    (end.getTime() - clockInAt.getTime()) / 60000,
  );
  return Math.max(0, raw - Math.max(0, breakMinutes || 0));
}

@Injectable()
export class IamAttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async clockIn(user: AuthUser, dto: ClockDto) {
    const open = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
        clockInAt: { not: null },
      },
    });
    if (open) {
      throw new BadRequestException('Already clocked in — clock out first');
    }

    const workDate = parseWorkDate(todayYmd());
    const now = new Date();
    const created = await this.prisma.attendanceEntry.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        locationId: dto.locationId ?? user.locationId ?? null,
        workDate,
        clockInAt: now,
        breakMinutes: 0,
        status: 'present',
        method: dto.method ?? 'manual',
        notes: dto.notes,
      },
    });
    await this.audit(user, created.id, 'attendance.clock_in', {
      after: this.slim(created),
    });
    return this.mapRow(
      await this.prisma.attendanceEntry.findFirstOrThrow({
        where: { id: created.id },
        include: this.include(),
      }),
    );
  }

  async clockOut(user: AuthUser, dto: ClockDto) {
    const open = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
        clockInAt: { not: null },
      },
      orderBy: { clockInAt: 'desc' },
    });
    if (!open) throw new BadRequestException('Not clocked in');
    const updated = await this.prisma.attendanceEntry.update({
      where: { id: open.id },
      data: {
        clockOutAt: new Date(),
        notes: dto.notes ?? open.notes,
        method: dto.method ?? open.method,
      },
      include: this.include(),
    });
    await this.audit(user, updated.id, 'attendance.clock_out', {
      before: this.slim(open),
      after: this.slim(updated),
    });
    return this.mapRow(updated);
  }

  async myOpen(user: AuthUser) {
    const row = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        clockOutAt: null,
        clockInAt: { not: null },
      },
      include: this.include(),
    });
    return row ? this.mapRow(row) : null;
  }

  async list(user: AuthUser, query: ListAttendanceQueryDto) {
    const manage = this.canManage(user);
    const where: Record<string, unknown> = { tenantId: user.tenantId };

    if (!manage) {
      where.userId = user.userId;
    } else if (query.userId) {
      where.userId = query.userId;
    }

    if (query.workDate) {
      where.workDate = parseWorkDate(query.workDate);
    } else if (query.from || query.to) {
      where.OR = [
        {
          workDate: {
            ...(query.from ? { gte: parseWorkDate(query.from) } : {}),
            ...(query.to ? { lte: parseWorkDate(query.to) } : {}),
          },
        },
        {
          workDate: null,
          clockInAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T23:59:59`) } : {}),
          },
        },
      ];
    }

    if (query.shiftId) where.shiftId = query.shiftId;
    if (query.status) where.status = query.status;

    const rows = await this.prisma.attendanceEntry.findMany({
      where,
      orderBy: [{ workDate: 'desc' }, { clockInAt: 'desc' }],
      take: 300,
      include: this.include(),
    });
    return rows.map((r) => this.mapRow(r));
  }

  async getOne(user: AuthUser, id: string) {
    const row = await this.requireEntry(user, id);
    if (!this.canManage(user) && row.userId !== user.userId) {
      throw new ForbiddenException('Not allowed to view this entry');
    }
    return this.mapRow(row);
  }

  async createManual(user: AuthUser, dto: CreateAttendanceDto) {
    this.assertManage(user);
    const workDate = parseWorkDate(dto.workDate);
    await this.assertStaff(user.tenantId, dto.userId);
    if (dto.shiftId) await this.assertShift(user.tenantId, dto.shiftId);

    const dup = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: dto.userId,
        workDate,
      },
    });
    if (dup) {
      throw new BadRequestException(
        'Attendance already exists for this staff and date',
      );
    }

    const { clockInAt, clockOutAt, breakMinutes, status } =
      this.resolveTimes(dto);

    const created = await this.prisma.attendanceEntry.create({
      data: {
        tenantId: user.tenantId,
        userId: dto.userId,
        locationId: dto.locationId ?? null,
        workDate,
        shiftId: dto.shiftId ?? null,
        clockInAt,
        clockOutAt,
        breakMinutes,
        status,
        method: 'manual',
        notes: dto.notes?.trim() || null,
      },
      include: this.include(),
    });
    await this.audit(user, created.id, 'attendance.created', {
      after: this.slim(created),
    });
    return this.mapRow(created);
  }

  async update(user: AuthUser, id: string, dto: UpdateAttendanceDto) {
    this.assertManage(user);
    const existing = await this.requireEntry(user, id);

    const nextUserId = dto.userId ?? existing.userId;
    const nextWorkDate = dto.workDate
      ? parseWorkDate(dto.workDate)
      : existing.workDate ??
        (existing.clockInAt
          ? parseWorkDate(ymdFromDate(existing.clockInAt))
          : parseWorkDate(todayYmd()));

    if (dto.userId) await this.assertStaff(user.tenantId, dto.userId);
    if (dto.shiftId) await this.assertShift(user.tenantId, dto.shiftId);

    const clash = await this.prisma.attendanceEntry.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: nextUserId,
        workDate: nextWorkDate,
        id: { not: id },
      },
    });
    if (clash) {
      throw new BadRequestException(
        'Attendance already exists for this staff and date',
      );
    }

    const ymd = ymdFromDate(nextWorkDate);
    const status = dto.status ?? existing.status;
    const breakMinutes =
      dto.breakMinutes !== undefined
        ? dto.breakMinutes
        : existing.breakMinutes;

    let clockInAt = existing.clockInAt;
    let clockOutAt = existing.clockOutAt;
    if (dto.clockIn !== undefined) {
      clockInAt =
        dto.clockIn === null || dto.clockIn === ''
          ? null
          : combineDateTime(ymd, dto.clockIn);
    }
    if (dto.clockOut !== undefined) {
      clockOutAt =
        dto.clockOut === null || dto.clockOut === ''
          ? null
          : combineDateTime(ymd, dto.clockOut);
    }

    this.validateStatusTimes(status, clockInAt, clockOutAt, breakMinutes);

    const updated = await this.prisma.attendanceEntry.update({
      where: { id },
      data: {
        userId: nextUserId,
        workDate: nextWorkDate,
        shiftId:
          dto.shiftId === undefined ? existing.shiftId : dto.shiftId,
        clockInAt,
        clockOutAt,
        breakMinutes,
        status,
        notes:
          dto.notes === undefined ? existing.notes : dto.notes?.trim() || null,
        method: existing.method || 'manual',
      },
      include: this.include(),
    });
    await this.audit(user, id, 'attendance.updated', {
      before: this.slim(existing),
      after: this.slim(updated),
    });
    return this.mapRow(updated);
  }

  async remove(user: AuthUser, id: string) {
    this.assertManage(user);
    const existing = await this.requireEntry(user, id);
    await this.prisma.attendanceEntry.delete({ where: { id } });
    await this.audit(user, id, 'attendance.deleted', {
      before: this.slim(existing),
    });
    return { ok: true };
  }

  private resolveTimes(dto: CreateAttendanceDto) {
    const status = dto.status;
    const breakMinutes = Math.max(0, dto.breakMinutes ?? 0);
    let clockInAt: Date | null = null;
    let clockOutAt: Date | null = null;

    if (!NO_TIME_STATUSES.has(status)) {
      if (!dto.clockIn) {
        throw new BadRequestException('Clock In is required for this status');
      }
      clockInAt = combineDateTime(dto.workDate, dto.clockIn);
      if (dto.clockOut) {
        clockOutAt = combineDateTime(dto.workDate, dto.clockOut);
      }
    } else {
      if (dto.clockIn) clockInAt = combineDateTime(dto.workDate, dto.clockIn);
      if (dto.clockOut) clockOutAt = combineDateTime(dto.workDate, dto.clockOut);
    }

    this.validateStatusTimes(status, clockInAt, clockOutAt, breakMinutes);
    return { clockInAt, clockOutAt, breakMinutes, status };
  }

  private validateStatusTimes(
    status: string,
    clockInAt: Date | null,
    clockOutAt: Date | null,
    breakMinutes: number,
  ) {
    if (clockInAt && clockOutAt && clockOutAt.getTime() <= clockInAt.getTime()) {
      throw new BadRequestException('Clock Out must be after Clock In');
    }
    if (
      clockInAt &&
      clockOutAt &&
      breakMinutes >
        Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60000)
    ) {
      throw new BadRequestException(
        'Break duration cannot exceed total clocked time',
      );
    }
    if (!NO_TIME_STATUSES.has(status) && !clockInAt) {
      throw new BadRequestException('Clock In is required for this status');
    }
  }

  private include() {
    return {
      user: { select: { id: true, fullName: true, email: true } },
      shift: {
        select: { id: true, name: true, startTime: true, endTime: true },
      },
    } as const;
  }

  private mapRow(r: {
    id: string;
    userId: string;
    locationId: string | null;
    workDate: Date | null;
    shiftId: string | null;
    clockInAt: Date | null;
    clockOutAt: Date | null;
    breakMinutes: number;
    status: string;
    method: string;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    user: { id: string; fullName: string; email: string };
    shift?: {
      id: string;
      name: string;
      startTime: string;
      endTime: string;
    } | null;
  }) {
    const workDate =
      r.workDate ?? (r.clockInAt ? parseWorkDate(ymdFromDate(r.clockInAt)) : null);
    const minutes = calcWorkedMinutes(
      r.clockInAt,
      r.clockOutAt,
      r.breakMinutes ?? 0,
    );
    const isOpenSession = Boolean(r.clockInAt && !r.clockOutAt);
    return {
      id: r.id,
      userId: r.userId,
      fullName: r.user.fullName,
      email: r.user.email,
      locationId: r.locationId,
      workDate: workDate ? ymdFromDate(workDate) : null,
      shiftId: r.shiftId,
      shift: r.shift
        ? {
            id: r.shift.id,
            name: r.shift.name,
            startTime: r.shift.startTime,
            endTime: r.shift.endTime,
          }
        : null,
      clockInAt: r.clockInAt,
      clockOutAt: r.clockOutAt,
      clockIn: r.clockInAt
        ? r.clockInAt.toTimeString().slice(0, 5)
        : null,
      clockOut: r.clockOutAt
        ? r.clockOutAt.toTimeString().slice(0, 5)
        : null,
      breakMinutes: r.breakMinutes ?? 0,
      status: r.status || 'present',
      method: r.method,
      notes: r.notes,
      minutes,
      isOpenSession,
      workingHours:
        minutes != null
          ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m${isOpenSession ? ' (running)' : ''}`
          : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private slim(r: {
    id: string;
    userId: string;
    workDate?: Date | null;
    shiftId?: string | null;
    clockInAt?: Date | null;
    clockOutAt?: Date | null;
    breakMinutes?: number;
    status?: string;
    method?: string;
    notes?: string | null;
  }) {
    return {
      id: r.id,
      userId: r.userId,
      workDate: r.workDate ? ymdFromDate(r.workDate) : null,
      shiftId: r.shiftId ?? null,
      clockInAt: r.clockInAt ?? null,
      clockOutAt: r.clockOutAt ?? null,
      breakMinutes: r.breakMinutes ?? 0,
      status: r.status ?? 'present',
      method: r.method ?? 'manual',
      notes: r.notes ?? null,
    };
  }

  private async requireEntry(user: AuthUser, id: string) {
    const row = await this.prisma.attendanceEntry.findFirst({
      where: { id, tenantId: user.tenantId },
      include: this.include(),
    });
    if (!row) throw new NotFoundException('Attendance entry not found');
    return row;
  }

  private async assertStaff(tenantId: string, userId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!staff) throw new NotFoundException('Staff not found');
  }

  private async assertShift(tenantId: string, shiftId: string) {
    const shift = await this.prisma.workShift.findFirst({
      where: { id: shiftId, tenantId },
      select: { id: true },
    });
    if (!shift) throw new NotFoundException('Shift not found');
  }

  private async audit(
    user: AuthUser,
    entityId: string,
    action: string,
    beforeAfter: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'attendance_entry',
        entityId,
        action,
        beforeAfter: beforeAfter as Prisma.InputJsonValue,
      },
    });
  }

  private canManage(user: AuthUser) {
    return (
      user.roles.includes('admin') ||
      user.roles.includes('manager') ||
      hasPermission(user.permissions, 'attendance.manage')
    );
  }

  private assertManage(user: AuthUser) {
    if (!this.canManage(user)) {
      throw new ForbiddenException('attendance.manage required');
    }
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
