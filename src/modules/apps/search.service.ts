import { Injectable } from '@nestjs/common';
import { FulfillmentMode } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';

/** Unified product + customer search for shell / command palette */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(user: AuthUser, qRaw: string, limit = 8) {
    const q = qRaw.trim();
    if (!q || q.length < 1) {
      return { q: '', products: [], customers: [] };
    }
    const take = Math.min(Math.max(limit, 1), 20);

    const [products, customers] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          tenantId: user.tenantId,
          isActive: true,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { shortName: { contains: q, mode: 'insensitive' } },
            { skuCode: { contains: q, mode: 'insensitive' } },
            { barcode: { contains: q, mode: 'insensitive' } },
            { internalCode: { contains: q, mode: 'insensitive' } },
          ],
        },
        take,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          skuCode: true,
          barcode: true,
          basePrice: true,
          kind: true,
          fulfillmentMode: true,
          photoUrl: true,
          category: { select: { id: true, name: true } },
        },
      }),
      this.prisma.customer.findMany({
        where: {
          tenantId: user.tenantId,
          deletedAt: null,
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        take,
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          dateOfBirth: true,
          marketingOptIn: true,
        },
      }),
    ]);

    return {
      q,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.skuCode,
        barcode: p.barcode,
        price: Number(p.basePrice),
        kind: p.kind,
        fulfillmentMode: p.fulfillmentMode,
        category: p.category?.name ?? null,
        image: p.photoUrl,
        href:
          p.fulfillmentMode === FulfillmentMode.sale
            ? `/catalog?q=${encodeURIComponent(p.skuCode || p.name)}`
            : `/catalog?q=${encodeURIComponent(p.name)}`,
      })),
      customers: customers.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        phone: c.phone,
        email: c.email,
        dateOfBirth: c.dateOfBirth
          ? c.dateOfBirth.toISOString().slice(0, 10)
          : null,
        marketingOptIn: c.marketingOptIn,
        href: `/customers?id=${c.id}`,
      })),
    };
  }
}
