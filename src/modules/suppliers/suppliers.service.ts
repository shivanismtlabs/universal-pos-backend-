import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoType } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  UpdatePurchaseOrderDto,
} from './dto/suppliers.dto';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  createSupplier(user: AuthUser, dto: CreateSupplierDto) {
    return this.prisma.supplier.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
        contact: dto.contact?.trim(),
        phone: dto.phone?.trim(),
      },
    });
  }

  listSuppliers(user: AuthUser) {
    return this.prisma.supplier.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async createPo(user: AuthUser, dto: CreatePurchaseOrderDto) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId: user.tenantId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    if (dto.linkedOrderId) {
      const order = await this.prisma.rentalOrder.findFirst({
        where: { id: dto.linkedOrderId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!order) throw new NotFoundException('Linked order not found');
    }

    return this.prisma.purchaseOrder.create({
      data: {
        tenantId: user.tenantId,
        supplierId: dto.supplierId,
        poType: dto.poType ?? PoType.purchase,
        linkedOrderId: dto.linkedOrderId,
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
        status: 'draft',
      },
      include: { supplier: true },
    });
  }

  listPos(user: AuthUser) {
    return this.prisma.purchaseOrder.findMany({
      where: { tenantId: user.tenantId },
      include: { supplier: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updatePo(user: AuthUser, id: string, dto: UpdatePurchaseOrderDto) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    const allowed = ['draft', 'ordered', 'partial', 'received', 'cancelled'];
    if (dto.status && !allowed.includes(dto.status)) {
      throw new BadRequestException(`Invalid status. Use: ${allowed.join(', ')}`);
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        status: dto.status,
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
      },
      include: { supplier: true },
    });
  }
}
