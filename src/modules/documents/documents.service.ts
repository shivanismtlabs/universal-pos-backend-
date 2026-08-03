import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { CreateDocumentDto, ListDocumentsQueryDto } from './dto/documents.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateDocumentDto) {
    if (dto.orderId) {
      await this.assertExists(
        'rentalOrder',
        user.tenantId,
        dto.orderId,
        'Order',
      );
    }
    if (dto.customerId) {
      await this.assertExists(
        'customer',
        user.tenantId,
        dto.customerId,
        'Customer',
      );
    }
    if (dto.returnEventId) {
      await this.assertExists(
        'returnEvent',
        user.tenantId,
        dto.returnEventId,
        'Return event',
      );
    }

    return this.prisma.document.create({
      data: {
        tenantId: user.tenantId,
        docType: dto.docType,
        storageKey: dto.storageKey,
        orderId: dto.orderId,
        customerId: dto.customerId,
        returnEventId: dto.returnEventId,
      },
    });
  }

  list(user: AuthUser, query: ListDocumentsQueryDto) {
    const where: Prisma.DocumentWhereInput = {
      tenantId: user.tenantId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
    };

    return this.prisma.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(user: AuthUser, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async acknowledge(user: AuthUser, id: string) {
    await this.getById(user, id);
    return this.prisma.document.update({
      where: { id },
      data: { customerAcknowledged: true, signedAt: new Date() },
    });
  }

  private async assertExists(
    model: 'rentalOrder' | 'customer' | 'returnEvent',
    tenantId: string,
    id: string,
    label: string,
  ) {
    const delegate = this.prisma[model] as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    };
    const row = await delegate.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`${label} not found`);
  }
}
