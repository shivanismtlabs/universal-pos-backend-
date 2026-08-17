import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ResourceStatus } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateResourceDto,
  ListResourcesQueryDto,
  UpdateResourceDto,
} from './dto/resources.dto';

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateResourceDto) {
    if (dto.locationId) {
      await this.assertLocation(user.tenantId, dto.locationId);
    }
    const row = await this.prisma.resource.create({
      data: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        name: dto.name.trim(),
        type: dto.type.trim().toLowerCase(),
        capacity: dto.capacity ?? 1,
        status: dto.status ?? ResourceStatus.available,
        sortOrder: dto.sortOrder ?? 0,
        meta: (dto.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
    return this.present(row);
  }

  async list(user: AuthUser, query: ListResourcesQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const q = query.q?.trim();
    const where: Prisma.ResourceWhereInput = {
      tenantId: user.tenantId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.type ? { type: query.type.trim().toLowerCase() } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { type: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.resource.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.resource.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), meta: pageMeta(page, limit, total) };
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.resource.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Resource not found');
    return this.present(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateResourceDto) {
    await this.get(user, id);
    if (dto.locationId) {
      await this.assertLocation(user.tenantId, dto.locationId);
    }
    const row = await this.prisma.resource.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.type !== undefined
          ? { type: dto.type.trim().toLowerCase() }
          : {}),
        ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.meta !== undefined
          ? { meta: dto.meta as Prisma.InputJsonValue }
          : {}),
      },
    });
    return this.present(row);
  }

  async remove(user: AuthUser, id: string) {
    await this.get(user, id);
    await this.prisma.resource.delete({ where: { id } });
    return { ok: true };
  }

  private present(row: {
    id: string;
    tenantId: string;
    locationId: string | null;
    name: string;
    type: string;
    capacity: number;
    status: ResourceStatus;
    sortOrder: number;
    meta: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      locationId: row.locationId,
      name: row.name,
      type: row.type,
      capacity: row.capacity,
      status: row.status,
      sortOrder: row.sortOrder,
      meta: row.meta,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
  }
}
