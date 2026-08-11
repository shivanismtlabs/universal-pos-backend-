import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_PERMISSION_CODES,
  PERMISSION_CATALOG,
  SYSTEM_ROLE_CODES,
  SYSTEM_ROLE_PERMISSIONS,
  expandPermissions,
} from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateRoleDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/iam.dto';

@Injectable()
export class IamRolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ensure permission rows + system roles + default matrices exist for tenant. */
  async ensureTenantRbac(tenantId: string) {
    for (const p of PERMISSION_CATALOG) {
      await this.prisma.permission.upsert({
        where: { code: p.code },
        create: {
          code: p.code,
          moduleCode: p.moduleCode,
          description: p.description,
        },
        update: {
          moduleCode: p.moduleCode,
          description: p.description,
        },
      });
    }

    for (const code of SYSTEM_ROLE_CODES) {
      await this.prisma.role.upsert({
        where: { tenantId_code: { tenantId, code } },
        create: {
          tenantId,
          code,
          name: this.prettyName(code),
          isSystem: true,
        },
        update: { isSystem: true, name: this.prettyName(code) },
      });
    }

    const allPerms = await this.prisma.permission.findMany({
      where: { code: { in: [...DEFAULT_PERMISSION_CODES] } },
    });
    const byCode = new Map(allPerms.map((p) => [p.code, p.id]));

    for (const code of SYSTEM_ROLE_CODES) {
      const role = await this.prisma.role.findUnique({
        where: { tenantId_code: { tenantId, code } },
      });
      if (!role) continue;
      const desired = SYSTEM_ROLE_PERMISSIONS[code] ?? [];
      const codes =
        desired[0] === '*' ? [...DEFAULT_PERMISSION_CODES] : [...desired];
      for (const pc of codes) {
        const permissionId = byCode.get(pc);
        if (!permissionId) continue;
        await this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: role.id, permissionId },
          },
          create: { roleId: role.id, permissionId },
          update: {},
        });
      }
    }
  }

  async resolvePermissions(userId: string, roleCodes: string[]) {
    const fromDb = await this.prisma.rolePermission.findMany({
      where: {
        role: { userRoles: { some: { userId } } },
      },
      select: { permission: { select: { code: true } } },
    });
    const codes = fromDb.map((r) => r.permission.code);
    return expandPermissions(roleCodes, codes);
  }

  async listPermissions() {
    await this.seedGlobalPermissions();
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  async listRoles(user: AuthUser) {
    await this.ensureTenantRbac(user.tenantId);
    const roles = await this.prisma.role.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
      include: {
        rolePermissions: {
          include: { permission: { select: { code: true, description: true } } },
        },
        _count: { select: { userRoles: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name ?? r.code,
      isSystem: r.isSystem,
      userCount: r._count.userRoles,
      permissions: r.rolePermissions.map((rp) => rp.permission.code),
      permissionDetails: r.rolePermissions.map((rp) => ({
        code: rp.permission.code,
        description: rp.permission.description,
      })),
    }));
  }

  async createRole(user: AuthUser, dto: CreateRoleDto) {
    this.assertRolesManage(user);
    await this.ensureTenantRbac(user.tenantId);
    const code = this.slugCode(dto.code || dto.name);
    if (SYSTEM_ROLE_CODES.includes(code as (typeof SYSTEM_ROLE_CODES)[number])) {
      throw new BadRequestException('Code reserved for a system role');
    }
    try {
      const role = await this.prisma.role.create({
        data: {
          tenantId: user.tenantId,
          code,
          name: dto.name.trim(),
          isSystem: false,
        },
      });
      if (dto.permissions?.length) {
        await this.setPermissionsInternal(user.tenantId, role.id, dto.permissions);
      }
      return this.getRole(user, role.id);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('Role code already exists');
      }
      throw e;
    }
  }

  async updateRole(user: AuthUser, id: string, dto: UpdateRoleDto) {
    this.assertRolesManage(user);
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem && dto.name === undefined) {
      // system name can be display-only updated lightly
    }
    await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? undefined,
      },
    });
    if (dto.permissions) {
      if (role.isSystem && role.code === 'admin') {
        throw new BadRequestException('Cannot change admin permission matrix');
      }
      await this.setPermissionsInternal(user.tenantId, id, dto.permissions);
    }
    return this.getRole(user, id);
  }

  async setPermissions(user: AuthUser, id: string, dto: SetRolePermissionsDto) {
    return this.updateRole(user, id, { permissions: dto.permissions });
  }

  async deleteRole(user: AuthUser, id: string) {
    this.assertRolesManage(user);
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }
    const users = await this.prisma.userRole.count({ where: { roleId: id } });
    if (users > 0) {
      throw new BadRequestException(
        'Reassign staff before deleting this role',
      );
    }
    await this.prisma.rolePermission.deleteMany({ where: { roleId: id } });
    await this.prisma.role.delete({ where: { id } });
    return { ok: true };
  }

  private async getRole(user: AuthUser, id: string) {
    const list = await this.listRoles(user);
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Role not found');
    return found;
  }

  private async setPermissionsInternal(
    tenantId: string,
    roleId: string,
    permissionCodes: string[],
  ) {
    await this.seedGlobalPermissions();
    const unique = [...new Set(permissionCodes.map((c) => c.trim()).filter(Boolean))];
    const perms = await this.prisma.permission.findMany({
      where: { code: { in: unique } },
    });
    if (perms.length !== unique.length) {
      const found = new Set(perms.map((p) => p.code));
      const missing = unique.filter((c) => !found.has(c));
      throw new BadRequestException(`Unknown permissions: ${missing.join(', ')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      for (const p of perms) {
        await tx.rolePermission.create({
          data: { roleId, permissionId: p.id },
        });
      }
    });
    void tenantId;
  }

  private async seedGlobalPermissions() {
    for (const p of PERMISSION_CATALOG) {
      await this.prisma.permission.upsert({
        where: { code: p.code },
        create: {
          code: p.code,
          moduleCode: p.moduleCode,
          description: p.description,
        },
        update: {
          moduleCode: p.moduleCode,
          description: p.description,
        },
      });
    }
  }

  private assertRolesManage(user: AuthUser) {
    const can =
      user.roles.includes('admin') ||
      user.roles.includes('manager') ||
      (user.permissions ?? []).includes('roles.manage') ||
      (user.permissions ?? []).includes('*');
    if (!can) throw new ForbiddenException('roles.manage required');
  }

  private slugCode(raw: string) {
    const s = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    if (!s || !/^[a-z]/.test(s)) {
      throw new BadRequestException('Invalid role code');
    }
    return s;
  }

  private prettyName(code: string) {
    const map: Record<string, string> = {
      admin: 'Admin (owner)',
      manager: 'Store Manager',
      cashier: 'Cashier',
      fitter: 'Fitter',
      inventory: 'Inventory Manager',
      accountant: 'Accountant',
      staff: 'Staff',
    };
    return map[code] ?? code;
  }
}
