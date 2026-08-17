import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WorkJobLineKind, WorkJobStatus } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateWorkAssetDto,
  CreateWorkJobDto,
  ListWorkAssetsQueryDto,
  ListWorkJobsQueryDto,
  UpdateWorkJobDto,
} from './dto/jobs.dto';

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  async createAsset(user: AuthUser, dto: CreateWorkAssetDto) {
    await this.assertCustomer(user.tenantId, dto.customerId);
    const row = await this.prisma.workAsset.create({
      data: {
        tenantId: user.tenantId,
        customerId: dto.customerId,
        name: dto.name.trim(),
        assetType: dto.assetType.trim().toLowerCase(),
        identifier: dto.identifier?.trim() || null,
        meta: (dto.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
    return this.presentAsset(row);
  }

  async listAssets(user: AuthUser, query: ListWorkAssetsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const q = query.q?.trim();
    const where: Prisma.WorkAssetWhereInput = {
      tenantId: user.tenantId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { identifier: { contains: q, mode: 'insensitive' } },
              { assetType: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.workAsset.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.presentAsset(r)),
      meta: pageMeta(page, limit, total),
    };
  }

  async createJob(user: AuthUser, dto: CreateWorkJobDto) {
    await this.assertCustomer(user.tenantId, dto.customerId);
    if (dto.assetId) await this.assertAsset(user.tenantId, dto.assetId);
    if (dto.assigneeId) await this.assertUser(user.tenantId, dto.assigneeId);
    if (dto.resourceId) await this.assertResource(user.tenantId, dto.resourceId);
    if (dto.locationId) await this.assertLocation(user.tenantId, dto.locationId);

    const row = await this.prisma.workJob.create({
      data: {
        tenantId: user.tenantId,
        customerId: dto.customerId,
        assetId: dto.assetId,
        locationId: dto.locationId,
        assigneeId: dto.assigneeId,
        resourceId: dto.resourceId,
        title: dto.title.trim(),
        problem: dto.problem?.trim(),
        estimatedCost:
          dto.estimatedCost != null
            ? new Prisma.Decimal(dto.estimatedCost)
            : undefined,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        meta: (dto.meta ?? {}) as Prisma.InputJsonValue,
        lines: dto.lines?.length
          ? {
              create: dto.lines.map((line) => ({
                tenantId: user.tenantId,
                productId: line.productId,
                kind: line.kind ?? WorkJobLineKind.other,
                description: line.description.trim(),
                qty: new Prisma.Decimal(line.qty ?? 1),
                unitPrice: new Prisma.Decimal(line.unitPrice ?? 0),
              })),
            }
          : undefined,
      },
      include: this.jobInclude(),
    });
    return this.presentJob(row);
  }

  async listJobs(user: AuthUser, query: ListWorkJobsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where: Prisma.WorkJobWhereInput = {
      tenantId: user.tenantId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workJob.findMany({
        where,
        include: this.jobInclude(),
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.workJob.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.presentJob(r)),
      meta: pageMeta(page, limit, total),
    };
  }

  async getJob(user: AuthUser, id: string) {
    const row = await this.prisma.workJob.findFirst({
      where: { id, tenantId: user.tenantId },
      include: this.jobInclude(),
    });
    if (!row) throw new NotFoundException('Job not found');
    return this.presentJob(row);
  }

  async updateJob(user: AuthUser, id: string, dto: UpdateWorkJobDto) {
    await this.getJob(user, id);
    if (dto.assigneeId) await this.assertUser(user.tenantId, dto.assigneeId);
    if (dto.assetId) await this.assertAsset(user.tenantId, dto.assetId);
    if (dto.resourceId) await this.assertResource(user.tenantId, dto.resourceId);

    const terminal: WorkJobStatus[] = [
      WorkJobStatus.completed,
      WorkJobStatus.picked_up,
      WorkJobStatus.cancelled,
    ];
    const row = await this.prisma.workJob.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
        ...(dto.assetId !== undefined ? { assetId: dto.assetId } : {}),
        ...(dto.resourceId !== undefined ? { resourceId: dto.resourceId } : {}),
        ...(dto.orderId !== undefined ? { orderId: dto.orderId } : {}),
        ...(dto.problem !== undefined ? { problem: dto.problem } : {}),
        ...(dto.diagnosis !== undefined ? { diagnosis: dto.diagnosis } : {}),
        ...(dto.estimatedCost !== undefined
          ? { estimatedCost: new Prisma.Decimal(dto.estimatedCost) }
          : {}),
        ...(dto.finalCost !== undefined
          ? { finalCost: new Prisma.Decimal(dto.finalCost) }
          : {}),
        ...(dto.meta !== undefined
          ? { meta: dto.meta as Prisma.InputJsonValue }
          : {}),
        ...(dto.status && terminal.includes(dto.status)
          ? { completedAt: new Date() }
          : {}),
      },
      include: this.jobInclude(),
    });
    return this.presentJob(row);
  }

  private jobInclude() {
    return {
      customer: { select: { id: true, fullName: true, phone: true } },
      asset: true,
      assignee: { select: { id: true, fullName: true } },
      resource: { select: { id: true, name: true, type: true } },
      lines: true,
    } satisfies Prisma.WorkJobInclude;
  }

  private presentAsset(row: {
    id: string;
    tenantId: string;
    customerId: string;
    name: string;
    assetType: string;
    identifier: string | null;
    meta: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      name: row.name,
      assetType: row.assetType,
      identifier: row.identifier,
      meta: row.meta,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private presentJob(
    row: Prisma.WorkJobGetPayload<{ include: ReturnType<JobsService['jobInclude']> }>,
  ) {
    const linesTotal = row.lines.reduce(
      (sum, l) => sum + Number(l.qty) * Number(l.unitPrice),
      0,
    );
    return {
      id: row.id,
      tenantId: row.tenantId,
      locationId: row.locationId,
      customerId: row.customerId,
      customer: row.customer,
      assetId: row.assetId,
      asset: row.asset ? this.presentAsset(row.asset) : null,
      assigneeId: row.assigneeId,
      assignee: row.assignee,
      resourceId: row.resourceId,
      resource: row.resource,
      orderId: row.orderId,
      title: row.title,
      status: row.status,
      problem: row.problem,
      diagnosis: row.diagnosis,
      estimatedCost: row.estimatedCost != null ? Number(row.estimatedCost) : null,
      finalCost: row.finalCost != null ? Number(row.finalCost) : null,
      linesTotal,
      dueAt: row.dueAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      meta: row.meta,
      lines: row.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        kind: l.kind,
        description: l.description,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        lineTotal: Number(l.qty) * Number(l.unitPrice),
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async assertCustomer(tenantId: string, customerId: string) {
    const row = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Customer not found');
  }

  private async assertAsset(tenantId: string, assetId: string) {
    const row = await this.prisma.workAsset.findFirst({
      where: { id: assetId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Asset not found');
  }

  private async assertUser(tenantId: string, userId: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!row) throw new BadRequestException('Assignee not found');
  }

  private async assertResource(tenantId: string, resourceId: string) {
    const row = await this.prisma.resource.findFirst({
      where: { id: resourceId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Resource not found');
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const row = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Location not found');
  }
}
