import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { AssignRoleDto, CreateUserDto, UpdateUserDto } from './dto/users.dto';

const BCRYPT_ROUNDS = 12;
const DEFAULT_ROLE_CODE = 'staff';

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  isActive: true,
  primaryLocationId: true,
  lastLoginAt: true,
  createdAt: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      jobTitle: true,
      status: true,
    },
  },
  userRoles: {
    select: {
      role: { select: { id: true, code: true } },
      locationId: true,
    },
  },
  memberships: {
    where: { status: 'active' },
    select: {
      id: true,
      locationId: true,
      role: { select: { code: true } },
    },
  },
} satisfies Prisma.UserSelect;

function toUserView(
  user: Prisma.UserGetPayload<{ select: typeof USER_SELECT }>,
) {
  const { userRoles, ...rest } = user;
  return {
    ...rest,
    primaryStoreId: rest.primaryLocationId,
    roles: userRoles.map((ur) => ur.role.code),
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();
    const roleCode = (dto.roleCode ?? DEFAULT_ROLE_CODE).trim().toLowerCase();
    const locationId = dto.primaryLocationId ?? dto.primaryStoreId;

    const existing = await this.prisma.user.findFirst({
      where: { tenantId: user.tenantId, email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    if (locationId) {
      await this.assertLocation(user.tenantId, locationId);
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const employeeCount = await this.prisma.employee.count({
      where: { tenantId: user.tenantId },
    });

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.upsert({
          where: {
            tenantId_code: { tenantId: user.tenantId, code: roleCode },
          },
          create: {
            tenantId: user.tenantId,
            code: roleCode,
            name: roleCode,
          },
          update: {},
        });

        const newUser = await tx.user.create({
          data: {
            tenantId: user.tenantId,
            email,
            phone: dto.phone,
            fullName: dto.fullName.trim(),
            passwordHash,
            primaryLocationId: locationId,
            isActive: true,
            passwordChangedAt: new Date(),
          },
        });

        await tx.employee.create({
          data: {
            tenantId: user.tenantId,
            userId: newUser.id,
            employeeCode: `E${String(employeeCount + 1).padStart(3, '0')}`,
            status: 'active',
            hiredAt: new Date(),
            jobTitle: dto.jobTitle?.trim(),
          },
        });

        await tx.userRole.create({
          data: {
            userId: newUser.id,
            roleId: role.id,
            locationId: locationId ?? null,
          },
        });

        if (locationId) {
          await tx.membership.create({
            data: {
              tenantId: user.tenantId,
              userId: newUser.id,
              locationId,
              roleId: role.id,
              status: 'active',
            },
          });
        }

        return tx.user.findUniqueOrThrow({
          where: { id: newUser.id },
          select: USER_SELECT,
        });
      });

      return toUserView(created);
    } catch (e) {
      throwIfUnique(e, 'User with this email already exists');
    }
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.user.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      select: USER_SELECT,
    });
    return rows.map(toUserView);
  }

  async getById(user: AuthUser, id: string) {
    const row = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId },
      select: USER_SELECT,
    });
    if (!row) throw new NotFoundException('User not found');
    return toUserView(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const locationId = dto.primaryLocationId ?? dto.primaryStoreId;
    if (locationId) {
      await this.assertLocation(user.tenantId, locationId);
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (locationId !== undefined) {
      data.primaryLocation = { connect: { id: locationId } };
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    await this.prisma.user.update({ where: { id }, data });

    if (dto.jobTitle !== undefined) {
      await this.prisma.employee.updateMany({
        where: { userId: id, tenantId: user.tenantId },
        data: { jobTitle: dto.jobTitle.trim() },
      });
    }

    return this.getById(user, id);
  }

  async assignRole(user: AuthUser, id: string, dto: AssignRoleDto) {
    const existing = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true, primaryLocationId: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const roleCode = dto.roleCode.trim().toLowerCase();
    const locationId = dto.locationId ?? existing.primaryLocationId ?? null;

    if (locationId) {
      await this.assertLocation(user.tenantId, locationId);
    }

    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: {
          tenantId_code: { tenantId: user.tenantId, code: roleCode },
        },
        create: {
          tenantId: user.tenantId,
          code: roleCode,
          name: roleCode,
        },
        update: {},
      });

      const already = await tx.userRole.findFirst({
        where: {
          userId: id,
          roleId: role.id,
          locationId,
        },
        select: { id: true },
      });
      if (!already) {
        await tx.userRole.create({
          data: {
            userId: id,
            roleId: role.id,
            locationId,
          },
        });
      }

      if (locationId) {
        const mem = await tx.membership.findFirst({
          where: {
            userId: id,
            locationId,
            roleId: role.id,
            status: 'active',
          },
        });
        if (!mem) {
          await tx.membership.create({
            data: {
              tenantId: user.tenantId,
              userId: id,
              locationId,
              roleId: role.id,
              status: 'active',
            },
          });
        }
      }
    });

    return this.getById(user, id);
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Location not found or inactive');
    }
  }
}
