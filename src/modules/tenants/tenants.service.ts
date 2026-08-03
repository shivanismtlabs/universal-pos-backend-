import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateStoreDto,
  UpdateStoreDto,
  UpdateTenantDto,
} from './dto/tenants.dto';

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  gstin: true,
  status: true,
  branding: true,
  settings: true,
} satisfies Prisma.TenantSelect;

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: TENANT_SELECT,
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  async updateMe(user: AuthUser, dto: UpdateTenantDto) {
    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.gstin !== undefined) data.gstin = dto.gstin.toUpperCase();
    if (dto.branding !== undefined)
      data.branding = dto.branding as Prisma.InputJsonValue;
    if (dto.settings !== undefined)
      data.settings = dto.settings as Prisma.InputJsonValue;

    return this.prisma.tenant.update({
      where: { id: user.tenantId },
      data,
      select: TENANT_SELECT,
    });
  }

  listStores(user: AuthUser) {
    return this.prisma.store.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createStore(user: AuthUser, dto: CreateStoreDto) {
    const code = (dto.code ?? (dto.isMain ? 'MAIN' : undefined))
      ?.trim()
      .toUpperCase();
    if (!code) {
      throw new BadRequestException('code is required unless isMain is true');
    }

    try {
      return await this.prisma.store.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          code,
          address: dto.address?.trim(),
          isActive: true,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Store code already exists for this shop');
    }
  }

  async getStore(user: AuthUser, id: string) {
    const store = await this.prisma.store.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async updateStore(user: AuthUser, id: string, dto: UpdateStoreDto) {
    await this.getStore(user, id);

    const data: Prisma.StoreUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.store.update({ where: { id }, data });
  }
}
