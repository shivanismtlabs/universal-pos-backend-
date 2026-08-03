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
  primaryStoreId: true,
  lastLoginAt: true,
  createdAt: true,
  userRoles: {
    select: { role: { select: { id: true, code: true } }, storeId: true },
  },
} satisfies Prisma.UserSelect;

function toUserView(
  user: Prisma.UserGetPayload<{ select: typeof USER_SELECT }>,
) {
  const { userRoles, ...rest } = user;
  return { ...rest, roles: userRoles.map((ur) => ur.role.code) };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();
    const roleCode = (dto.roleCode ?? DEFAULT_ROLE_CODE).trim().toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: { tenantId: user.tenantId, email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    if (dto.primaryStoreId) {
      await this.assertStore(user.tenantId, dto.primaryStoreId);
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.upsert({
          where: { tenantId_code: { tenantId: user.tenantId, code: roleCode } },
          create: { tenantId: user.tenantId, code: roleCode },
          update: {},
        });

        const newUser = await tx.user.create({
          data: {
            tenantId: user.tenantId,
            email,
            phone: dto.phone,
            fullName: dto.fullName.trim(),
            passwordHash,
            primaryStoreId: dto.primaryStoreId,
            isActive: true,
            passwordChangedAt: new Date(),
          },
        });

        await tx.userRole.create({
          data: {
            userId: newUser.id,
            roleId: role.id,
            storeId: dto.primaryStoreId,
          },
        });

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

    if (dto.primaryStoreId) {
      await this.assertStore(user.tenantId, dto.primaryStoreId);
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.primaryStoreId !== undefined) {
      data.primaryStore = { connect: { id: dto.primaryStoreId } };
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    await this.prisma.user.update({ where: { id }, data });
    return this.getById(user, id);
  }

  async assignRole(user: AuthUser, id: string, dto: AssignRoleDto) {
    const existing = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true, primaryStoreId: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const roleCode = dto.roleCode.trim().toLowerCase();

    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId: user.tenantId, code: roleCode } },
        create: { tenantId: user.tenantId, code: roleCode },
        update: {},
      });

      const storeId = existing.primaryStoreId ?? null;
      const already = await tx.userRole.findFirst({
        where: {
          userId: id,
          roleId: role.id,
          storeId,
        },
        select: { id: true },
      });
      if (!already) {
        await tx.userRole.create({
          data: {
            userId: id,
            roleId: role.id,
            storeId,
          },
        });
      }
    });

    return this.getById(user, id);
  }

  private async assertStore(tenantId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found or inactive');
  }
}
