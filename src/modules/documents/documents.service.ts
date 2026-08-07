import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { CreateDocumentDto, ListDocumentsQueryDto } from './dto/documents.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateDocumentDto) {
    if (dto.orderId) {
      await this.assertExists('order', user.tenantId, dto.orderId, 'Order');
    }
    if (dto.customerId) {
      await this.assertExists(
        'customer',
        user.tenantId,
        dto.customerId,
        'Customer',
      );
    }

    const type = (dto.type ?? dto.docType) as DocumentType | undefined;
    if (!type) {
      throw new BadRequestException('type (or docType) is required');
    }

    return this.prisma.document.create({
      data: {
        tenantId: user.tenantId,
        type,
        storageKey: dto.storageKey,
        orderId: dto.orderId,
        customerId: dto.customerId,
        meta: {
          ...(dto.returnEventId ? { returnEventId: dto.returnEventId } : {}),
        },
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
    const doc = await this.getById(user, id);
    const meta = {
      ...((doc.meta as object) ?? {}),
      customerAcknowledged: true,
      signedAt: new Date().toISOString(),
    };
    return this.prisma.document.update({
      where: { id },
      data: { meta },
    });
  }

  private async assertExists(
    model: 'order' | 'customer',
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
