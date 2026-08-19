import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoType, Prisma, StockLedgerType, SupplierStatus } from '@prisma/client';
import {
  buildTaxProfile,
  computeInvoiceTax,
} from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import { AccountingPostingService } from '../accounting/posting.service';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';
import { saveProductImage } from '../../common/product-image';
import { RoleGroup } from '../../common/roles';
import type { AuthUser } from '../auth/types';
import {
  AddSupplierNoteDto,
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  CreateSupplierInvoiceDto,
  CreateSupplierPaymentDto,
  PaySupplierInvoiceDto,
  ReceivePurchaseOrderDto,
  SupplierAddressDto,
  SupplierContactDto,
  UpdatePurchaseOrderDto,
  UploadSupplierDocumentDto,
} from './dto/suppliers.dto';

const PO_BLOCKED: SupplierStatus[] = [
  SupplierStatus.blocked,
  SupplierStatus.archived,
  SupplierStatus.inactive,
  SupplierStatus.on_hold,
];

function canSeeBank(user: AuthUser) {
  const roles = user.roles ?? [];
  return RoleGroup.finance.some((r) => roles.includes(r));
}

function maskAccount(v?: string | null) {
  const s = (v ?? '').trim();
  if (s.length <= 4) return s ? '••••' : null;
  return `••••${s.slice(-4)}`;
}

function asStatus(v?: string): SupplierStatus | undefined {
  if (!v) return undefined;
  const allowed = Object.values(SupplierStatus) as string[];
  if (!allowed.includes(v)) {
    throw new BadRequestException('Invalid supplier status');
  }
  return v as SupplierStatus;
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingPostingService,
    private readonly stock: StockMutationEngine,
  ) {}

  createSupplier(user: AuthUser, dto: CreateSupplierDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Supplier name is required');
    }
    return this.insertSupplier(user, dto);
  }

  private async nextSupplierCode(tenantId: string) {
    const rows = await this.prisma.supplier.findMany({
      where: { tenantId, code: { startsWith: 'SUP-' } },
      select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
      const m = r.code.match(/^SUP-(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `SUP-${String(max + 1).padStart(6, '0')}`;
  }

  private supplierData(
    tenantId: string,
    dto: CreateSupplierDto,
    code: string,
    finance: boolean,
  ) {
    return {
      tenantId,
      code,
      name: dto.name!.trim(),
      legalName: dto.legalName?.trim() || null,
      supplierType: dto.supplierType?.trim() || null,
      category: dto.category?.trim() || null,
      status: asStatus(dto.status) ?? SupplierStatus.active,
      contact: dto.contact?.trim() || null,
      designation: dto.designation?.trim() || null,
      phone: dto.phone?.trim() || null,
      phoneAlt: dto.phoneAlt?.trim() || null,
      email: dto.email?.trim() || null,
      website: dto.website?.trim() || null,
      notes: dto.notes?.trim() || null,
      taxId: dto.taxId?.trim() || null,
      taxCategory: dto.taxCategory?.trim() || null,
      taxExempt: dto.taxExempt === true,
      registrationNo: dto.registrationNo?.trim() || null,
      paymentTerm: dto.paymentTerm?.trim() || null,
      dueDays: dto.dueDays ?? null,
      creditLimit:
        dto.creditLimit != null && Number.isFinite(dto.creditLimit)
          ? dto.creditLimit
          : null,
      currencyCode: dto.currencyCode?.trim().toUpperCase() || null,
      preferredPayMethod: dto.preferredPayMethod?.trim() || null,
      bankName: finance ? dto.bankName?.trim() || null : null,
      bankAccountName: finance ? dto.bankAccountName?.trim() || null : null,
      bankAccountNo: finance ? dto.bankAccountNo?.trim() || null : null,
      bankIdentifier: finance ? dto.bankIdentifier?.trim() || null : null,
      payHandle: finance ? dto.payHandle?.trim() || null : null,
    } satisfies Prisma.SupplierUncheckedCreateInput;
  }

  private presentSupplier(row: any, user: AuthUser, nested = false) {
    const bank = canSeeBank(user);
    const base = {
      id: row.id,
      code: row.code,
      name: row.name,
      legalName: row.legalName,
      supplierType: row.supplierType,
      category: row.category,
      status: row.status,
      contact: row.contact,
      designation: row.designation,
      phone: row.phone,
      phoneAlt: row.phoneAlt,
      email: row.email,
      website: row.website,
      notes: row.notes,
      taxId: row.taxId,
      taxCategory: row.taxCategory,
      taxExempt: row.taxExempt,
      registrationNo: row.registrationNo,
      paymentTerm: row.paymentTerm,
      dueDays: row.dueDays,
      creditLimit:
        row.creditLimit != null ? Number(row.creditLimit) : null,
      currencyCode: row.currencyCode,
      preferredPayMethod: row.preferredPayMethod,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      bank: bank
        ? {
            bankName: row.bankName,
            bankAccountName: row.bankAccountName,
            bankAccountNo: row.bankAccountNo,
            bankIdentifier: row.bankIdentifier,
            payHandle: row.payHandle,
          }
        : {
            bankName: row.bankName ? '••••' : null,
            bankAccountName: row.bankAccountName ? '••••' : null,
            bankAccountNo: maskAccount(row.bankAccountNo),
            bankIdentifier: row.bankIdentifier ? '••••' : null,
            payHandle: row.payHandle ? '••••' : null,
            masked: true,
          },
    };
    if (!nested || !('contacts' in row)) return base;
    return {
      ...base,
      contacts: row.contacts,
      addresses: row.addresses,
      documents: row.documents,
      notesFeed: row.activityNotes,
    };
  }

  private async insertSupplier(user: AuthUser, dto: CreateSupplierDto) {
    const code =
      dto.code?.trim().toUpperCase() ||
      (await this.nextSupplierCode(user.tenantId));
    const dup = await this.prisma.supplier.findFirst({
      where: { tenantId: user.tenantId, code: { equals: code, mode: 'insensitive' } },
      select: { id: true },
    });
    if (dup) throw new BadRequestException(`Supplier code ${code} already exists`);
    try {
      const created = await this.prisma.supplier.create({
        data: this.supplierData(user.tenantId, dto, code, canSeeBank(user)),
      });
      return this.presentSupplier(created, user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`Supplier code ${code} already exists`);
      }
      throw e;
    }
  }

  listSuppliers(user: AuthUser, status?: string) {
    const st = status ? asStatus(status) : undefined;
    return this.prisma.supplier
      .findMany({
        where: {
          tenantId: user.tenantId,
          ...(st ? { status: st } : {}),
        },
        orderBy: { name: 'asc' },
      })
      .then((rows) => rows.map((r) => this.presentSupplier(r, user)));
  }

  async getSupplier(user: AuthUser, id: string) {
    const row = await this.prisma.supplier.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
        addresses: { orderBy: { createdAt: 'asc' } },
        documents: { orderBy: { createdAt: 'desc' } },
        activityNotes: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return this.presentSupplier(row, user, true);
  }

  /** Open AP vs optional credit limit — generic, not GST-specific. */
  private async assertCreditLimit(
    user: AuthUser,
    supplierId: string,
    additional: number,
  ) {
    if (!(additional > 0)) return;
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, tenantId: user.tenantId },
      select: { creditLimit: true, name: true },
    });
    if (!supplier?.creditLimit) return;
    const cap = Number(supplier.creditLimit);
    if (!Number.isFinite(cap) || cap <= 0) return;
    const open = await this.prisma.supplierInvoice.findMany({
      where: {
        tenantId: user.tenantId,
        supplierId,
        status: { in: ['open', 'partial'] },
      },
      select: { grandTotal: true, amountPaid: true },
    });
    const due = open.reduce(
      (s, i) => s + Number(i.grandTotal) - Number(i.amountPaid),
      0,
    );
    if (due + additional > cap + 0.009) {
      throw new BadRequestException(
        `Credit limit ${cap.toFixed(2)} exceeded for ${supplier.name} (open AP ${due.toFixed(2)} + this ${additional.toFixed(2)})`,
      );
    }
  }

  async updateSupplier(user: AuthUser, id: string, dto: CreateSupplierDto) {
    const existing = await this.prisma.supplier.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!existing) throw new NotFoundException('Supplier not found');
    if (dto.code && dto.code.trim().toUpperCase() !== existing.code) {
      const code = dto.code.trim().toUpperCase();
      const dup = await this.prisma.supplier.findFirst({
        where: {
          tenantId: user.tenantId,
          id: { not: id },
          code: { equals: code, mode: 'insensitive' },
        },
      });
      if (dup) throw new BadRequestException(`Supplier code ${code} already exists`);
    }
    const finance = canSeeBank(user);
    const data: Prisma.SupplierUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.code !== undefined) data.code = dto.code.trim().toUpperCase();
    if (dto.legalName !== undefined) data.legalName = dto.legalName.trim() || null;
    if (dto.supplierType !== undefined)
      data.supplierType = dto.supplierType.trim() || null;
    if (dto.category !== undefined) data.category = dto.category.trim() || null;
    if (dto.status !== undefined) data.status = asStatus(dto.status);
    if (dto.contact !== undefined) data.contact = dto.contact.trim() || null;
    if (dto.designation !== undefined)
      data.designation = dto.designation.trim() || null;
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.phoneAlt !== undefined) data.phoneAlt = dto.phoneAlt.trim() || null;
    if (dto.email !== undefined) data.email = dto.email.trim() || null;
    if (dto.website !== undefined) data.website = dto.website.trim() || null;
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;
    if (dto.taxId !== undefined) data.taxId = dto.taxId.trim() || null;
    if (dto.taxCategory !== undefined)
      data.taxCategory = dto.taxCategory.trim() || null;
    if (dto.taxExempt !== undefined) data.taxExempt = dto.taxExempt;
    if (dto.registrationNo !== undefined)
      data.registrationNo = dto.registrationNo.trim() || null;
    if (dto.paymentTerm !== undefined)
      data.paymentTerm = dto.paymentTerm.trim() || null;
    if (dto.dueDays !== undefined) data.dueDays = dto.dueDays;
    if (dto.creditLimit !== undefined) data.creditLimit = dto.creditLimit;
    if (dto.currencyCode !== undefined)
      data.currencyCode = dto.currencyCode.trim().toUpperCase() || null;
    if (dto.preferredPayMethod !== undefined)
      data.preferredPayMethod = dto.preferredPayMethod.trim() || null;
    if (finance) {
      if (dto.bankName !== undefined) data.bankName = dto.bankName.trim() || null;
      if (dto.bankAccountName !== undefined)
        data.bankAccountName = dto.bankAccountName.trim() || null;
      if (dto.bankAccountNo !== undefined)
        data.bankAccountNo = dto.bankAccountNo.trim() || null;
      if (dto.bankIdentifier !== undefined)
        data.bankIdentifier = dto.bankIdentifier.trim() || null;
      if (dto.payHandle !== undefined)
        data.payHandle = dto.payHandle.trim() || null;
    }
    const updated = await this.prisma.supplier.update({
      where: { id },
      data,
    });
    return this.presentSupplier(updated, user);
  }

  async addContact(user: AuthUser, supplierId: string, dto: SupplierContactDto) {
    await this.getSupplier(user, supplierId);
    if (dto.isPrimary) {
      await this.prisma.supplierContact.updateMany({
        where: { tenantId: user.tenantId, supplierId },
        data: { isPrimary: false },
      });
      await this.prisma.supplier.update({
        where: { id: supplierId },
        data: {
          contact: dto.name.trim(),
          phone: dto.phone?.trim() || undefined,
          email: dto.email?.trim() || undefined,
        },
      });
    }
    return this.prisma.supplierContact.create({
      data: {
        tenantId: user.tenantId,
        supplierId,
        name: dto.name.trim(),
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        role: dto.role?.trim() || null,
        notes: dto.notes?.trim() || null,
        isPrimary: dto.isPrimary === true,
      },
    });
  }

  async addAddress(user: AuthUser, supplierId: string, dto: SupplierAddressDto) {
    await this.getSupplier(user, supplierId);
    return this.prisma.supplierAddress.create({
      data: {
        tenantId: user.tenantId,
        supplierId,
        kind: dto.kind || 'billing',
        line1: dto.line1.trim(),
        line2: dto.line2?.trim() || null,
        city: dto.city?.trim() || null,
        state: dto.state?.trim() || null,
        postalCode: dto.postalCode?.trim() || null,
        country: dto.country?.trim() || null,
        isDefault: dto.isDefault === true,
      },
    });
  }

  async addNote(user: AuthUser, supplierId: string, dto: AddSupplierNoteDto) {
    await this.getSupplier(user, supplierId);
    return this.prisma.supplierNote.create({
      data: {
        tenantId: user.tenantId,
        supplierId,
        body: dto.body.trim(),
        actorUserId: user.userId,
      },
    });
  }

  async addDocument(
    user: AuthUser,
    supplierId: string,
    dto: UploadSupplierDocumentDto,
  ) {
    await this.getSupplier(user, supplierId);
    const fileUrl = await saveProductImage(user.tenantId, dto.imageBase64);
    return this.prisma.supplierDocument.create({
      data: {
        tenantId: user.tenantId,
        supplierId,
        docType: dto.docType.trim(),
        fileUrl,
        fileName: dto.fileName?.trim() || null,
        notes: dto.notes?.trim() || null,
        uploadedBy: user.userId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });
  }

  async createPo(user: AuthUser, dto: CreatePurchaseOrderDto) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId: user.tenantId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const st = supplier.status;
    const financeOverride =
      canSeeBank(user) &&
      (st === SupplierStatus.blocked || st === SupplierStatus.on_hold);
    if (PO_BLOCKED.includes(st) && !financeOverride) {
      throw new BadRequestException(
        `Supplier is ${st.replaceAll('_', ' ')} — new purchase orders are not allowed`,
      );
    }

    if (dto.linkedOrderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: dto.linkedOrderId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!order) throw new NotFoundException('Linked order not found');
    }

    const lines = dto.lines ?? [];
    if (lines.length) {
      const ids = lines.map((l) => l.stockLevelId);
      const levels = await this.prisma.stockLevel.findMany({
        where: { tenantId: user.tenantId, id: { in: ids } },
        select: { id: true },
      });
      if (levels.length !== new Set(ids).size) {
        throw new BadRequestException('One or more stock levels not found');
      }
    }

    const estimated = lines.reduce(
      (s, l) => s + Number(l.unitCost ?? 0) * Number(l.qtyOrdered ?? 0),
      0,
    );
    await this.assertCreditLimit(user, dto.supplierId, estimated);

    return this.prisma.purchaseOrder.create({
      data: {
        tenantId: user.tenantId,
        supplierId: dto.supplierId,
        poType: dto.poType ?? PoType.purchase,
        linkedOrderId: dto.linkedOrderId,
        poNumber: await this.nextDocNumber(user.tenantId, 'PO'),
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
        status: 'draft',
        notes: dto.notes?.trim() || null,
        lines: lines.length
          ? {
              create: lines.map((l) => ({
                tenantId: user.tenantId,
                stockLevelId: l.stockLevelId,
                qtyOrdered: l.qtyOrdered,
                unitCost:
                  l.unitCost !== undefined && l.unitCost !== null
                    ? l.unitCost
                    : undefined,
              })),
            }
          : undefined,
      },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /po_number|purchase_order_lines|column .* does not exist/i.test(msg)
      ) {
        throw new BadRequestException(
          'Purchase order schema is outdated on this server. Apply migration 20260813193000_purchase_order_number_lines (po_number, notes, purchase_order_lines), then retry.',
        );
      }
      throw err;
    });
  }

  listPos(user: AuthUser) {
    return this.prisma.purchaseOrder.findMany({
      where: { tenantId: user.tenantId },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
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
    if (dto.status === 'received') {
      throw new BadRequestException(
        'Use POST /purchase-orders/:id/receive to put stock on the shelf',
      );
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        status: dto.status,
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
      },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Receive goods → increase StockLevel.qtyOnHand (atomic).
   */
  async receivePo(user: AuthUser, id: string, dto: ReceivePurchaseOrderDto) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'cancelled') {
      throw new BadRequestException('Cannot receive a cancelled PO');
    }

    return this.prisma.$transaction(async (tx) => {
      const results: Array<{
        stockLevelId: string;
        sku: string;
        qtyAdded: number;
        qtyOnHand: number;
        unitCost: number | null;
        purchaseOrderLineId: string;
      }> = [];

      for (const incoming of dto.lines) {
        if (incoming.qty < 1) {
          throw new BadRequestException('Receive qty must be ≥ 1');
        }
        const level = await tx.stockLevel.findFirst({
          where: { id: incoming.stockLevelId, tenantId: user.tenantId },
        });
        if (!level) {
          throw new NotFoundException(
            `Stock level ${incoming.stockLevelId} not found`,
          );
        }

        let line = po.lines.find((l) => l.stockLevelId === incoming.stockLevelId);
        if (!line) {
          line = await tx.purchaseOrderLine.create({
            data: {
              tenantId: user.tenantId,
              purchaseOrderId: po.id,
              stockLevelId: incoming.stockLevelId,
              qtyOrdered: incoming.qty,
              qtyReceived: 0,
            },
          });
        }

        await tx.purchaseOrderLine.update({
          where: { id: line.id },
          data: { qtyReceived: { increment: incoming.qty } },
        });

        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: level.locationId,
          stockLevelId: level.id,
          qty: incoming.qty,
          type: StockLedgerType.purchase_receive,
          reason: `PO ${po.poNumber ?? po.id}`,
          referenceType: 'purchase_order',
          referenceId: po.id,
          skipComponentExplosion: true,
          idempotencyKey: `po-receive:${po.id}:${level.id}:${incoming.qty}`,
        });
        const updated = await tx.stockLevel.findFirstOrThrow({
          where: { id: level.id },
        });

        results.push({
          stockLevelId: level.id,
          sku: level.sku,
          qtyAdded: incoming.qty,
          qtyOnHand: Number(updated.qtyOnHand),
          unitCost: line.unitCost != null ? Number(line.unitCost) : null,
          purchaseOrderLineId: line.id,
        });
      }

      const grnNumber = await this.nextDocNumber(user.tenantId, 'GRN', tx);
      const grn = await tx.goodsReceipt.create({
        data: {
          tenantId: user.tenantId,
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          grnNumber,
          actorUserId: user.userId,
          lines: {
            create: results.map((r) => ({
              tenantId: user.tenantId,
              stockLevelId: r.stockLevelId,
              purchaseOrderLineId: r.purchaseOrderLineId,
              qty: r.qtyAdded,
              unitCost: r.unitCost ?? undefined,
            })),
          },
        },
        include: {
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      const refreshed = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id, tenantId: user.tenantId },
      });
      const allReceived =
        refreshed.length > 0 &&
        refreshed.every((l) => l.qtyReceived >= l.qtyOrdered);
      const anyReceived = refreshed.some((l) => Number(l.qtyReceived) > 0);

      const status = allReceived
        ? 'received'
        : anyReceived
          ? 'partial'
          : po.status === 'draft'
            ? 'ordered'
            : po.status;

      const updatedPo = await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status },
        include: {
          supplier: true,
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  qtyOnHand: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      return {
        purchaseOrder: updatedPo,
        goodsReceipt: this.mapGrn(grn),
        received: results.map(({ purchaseOrderLineId: _p, unitCost: _u, ...r }) => r),
      };
    });
  }

  /**
   * Purchase return (RTV) — reverse stock from a received PO line.
   * Optionally creates a supplier credit note for the returned value.
   */
  async returnPo(
    user: AuthUser,
    id: string,
    dto: {
      lines: Array<{ stockLevelId: string; qty: number }>;
      reason?: string;
      reasonCode?: string;
      createCreditNote?: boolean;
      idempotencyKey?: string;
    },
  ) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true, supplier: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'cancelled' || po.status === 'draft') {
      throw new BadRequestException('PO has nothing to return yet');
    }

    if (dto.idempotencyKey) {
      const priors = await this.prisma.auditLog.findMany({
        where: {
          tenantId: user.tenantId,
          action: 'purchase.return',
          entityId: po.id,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const prior = priors.find((a) => {
        const ba = a.beforeAfter as { idempotencyKey?: string } | null;
        return ba?.idempotencyKey === dto.idempotencyKey;
      });
      if (prior) {
        const ba = prior.beforeAfter as {
          lines?: unknown;
          creditNoteId?: string | null;
        };
        return {
          purchaseOrder: await this.getPo(user, po.id),
          returned: ba.lines ?? [],
          creditNote: ba.creditNoteId
            ? await this.prisma.supplierInvoice
                .findFirst({
                  where: { id: ba.creditNoteId, tenantId: user.tenantId },
                  include: {
                    supplier: { select: { id: true, name: true } },
                    purchaseOrder: { select: { id: true, poNumber: true } },
                    goodsReceipt: { select: { id: true, grnNumber: true } },
                  },
                })
                .then((r) => (r ? this.mapInvoice(r) : null))
            : null,
          replayed: true,
        };
      }
    }

    if (dto.reasonCode) {
      const reason = await this.prisma.refundReason.findFirst({
        where: {
          tenantId: user.tenantId,
          code: dto.reasonCode,
          isActive: true,
          OR: [{ appliesTo: 'supplier' }, { appliesTo: 'both' }],
        },
      });
      if (!reason) {
        throw new BadRequestException(
          `Unknown purchase return reason: ${dto.reasonCode}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const results: Array<{
        stockLevelId: string;
        sku: string;
        qtyReturned: number;
        qtyOnHand: number;
        unitCost: number;
        lineValue: number;
      }> = [];
      let creditValue = 0;

      for (const line of dto.lines) {
        if (line.qty < 1) {
          throw new BadRequestException('Return qty must be ≥ 1');
        }
        const poLine = po.lines.find(
          (l) => l.stockLevelId === line.stockLevelId,
        );
        if (!poLine) {
          throw new BadRequestException(
            `No PO line for stock level ${line.stockLevelId}`,
          );
        }
        const received = Number(poLine.qtyReceived);
        if (line.qty > received) {
          throw new BadRequestException(
            `Cannot return ${line.qty} (only ${received} received)`,
          );
        }

        const level = await tx.stockLevel.findFirst({
          where: { id: line.stockLevelId, tenantId: user.tenantId },
        });
        if (!level) throw new NotFoundException('Stock level not found');
        if (Number(level.qtyOnHand) < line.qty) {
          throw new BadRequestException(
            `Insufficient on-hand stock for ${level.sku}`,
          );
        }

        const unitCost = Number(poLine.unitCost ?? 0);
        const lineValue = Number((unitCost * line.qty).toFixed(2));
        creditValue += lineValue;

        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qtyReceived: { decrement: line.qty } },
        });
        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: level.locationId,
          stockLevelId: level.id,
          qty: -line.qty,
          type: StockLedgerType.purchase_return,
          referenceType: 'purchase_return',
          referenceId: po.id,
          skipComponentExplosion: true,
        });
        const updated = await tx.stockLevel.findFirstOrThrow({
          where: { id: level.id },
        });
        results.push({
          stockLevelId: level.id,
          sku: level.sku,
          qtyReturned: line.qty,
          qtyOnHand: Number(updated.qtyOnHand),
          unitCost,
          lineValue,
        });
      }

      let creditNote: Awaited<ReturnType<typeof this.mapInvoice>> | null =
        null;
      const shouldCredit = dto.createCreditNote !== false && creditValue > 0;
      if (shouldCredit) {
        const invoiceNumber = await this.nextDocNumber(
          user.tenantId,
          'SCN',
          tx,
        );
        const inv = await tx.supplierInvoice.create({
          data: {
            tenantId: user.tenantId,
            supplierId: po.supplierId,
            purchaseOrderId: po.id,
            invoiceNumber,
            invoiceDate: new Date(),
            subtotal: creditValue.toFixed(2),
            taxTotal: '0',
            grandTotal: creditValue.toFixed(2),
            amountPaid: '0',
            status: 'credit',
            notes: `Auto credit from RTV ${po.poNumber}${
              dto.reasonCode ? ` · ${dto.reasonCode}` : ''
            }${dto.reason ? ` · ${dto.reason}` : ''}`,
          },
          include: {
            supplier: { select: { id: true, name: true } },
            purchaseOrder: { select: { id: true, poNumber: true } },
            goodsReceipt: { select: { id: true, grnNumber: true } },
          },
        });
        creditNote = this.mapInvoice(inv);
      }

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'purchase_order',
          entityId: po.id,
          action: 'purchase.return',
          beforeAfter: {
            reason: dto.reason ?? null,
            reasonCode: dto.reasonCode ?? null,
            idempotencyKey: dto.idempotencyKey ?? null,
            lines: results,
            creditNoteId: creditNote?.id ?? null,
            creditValue,
          },
        },
      });

      const refreshed = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id },
      });
      const anyOnShelf = refreshed.some((l) => Number(l.qtyReceived) > 0);
      const status = anyOnShelf ? 'partial' : 'ordered';

      const updatedPo = await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status },
        include: {
          supplier: true,
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  qtyOnHand: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      return { purchaseOrder: updatedPo, returned: results, creditNote };
    });
  }

  // ── GRN / AP invoices / payments / ledger ───────────────────────────────

  listGoodsReceipts(user: AuthUser) {
    return this.prisma.goodsReceipt
      .findMany({
        where: { tenantId: user.tenantId },
        orderBy: { receivedAt: 'desc' },
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: {
            select: { id: true, poNumber: true, status: true },
          },
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      })
      .then((rows) => rows.map((r) => this.mapGrn(r)));
  }

  async getGoodsReceipt(user: AuthUser, id: string) {
    const row = await this.prisma.goodsReceipt.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        supplier: { select: { id: true, name: true } },
        purchaseOrder: {
          select: { id: true, poNumber: true, status: true },
        },
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('GRN not found');
    return this.mapGrn(row);
  }

  async createInvoice(user: AuthUser, dto: CreateSupplierInvoiceDto) {
    await this.getSupplier(user, dto.supplierId);
    if (dto.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: {
          id: dto.purchaseOrderId,
          tenantId: user.tenantId,
          supplierId: dto.supplierId,
        },
      });
      if (!po) throw new NotFoundException('Purchase order not found');
    }
    if (dto.goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findFirst({
        where: {
          id: dto.goodsReceiptId,
          tenantId: user.tenantId,
          supplierId: dto.supplierId,
        },
      });
      if (!grn) throw new NotFoundException('GRN not found');
    }

    const subtotal = Number(dto.subtotal);
    const taxTotal = Number(dto.taxTotal ?? 0);
    const isCredit = dto.isCredit === true;
    const grandTotal = Number((subtotal + taxTotal).toFixed(2));
    if (!isCredit) {
      await this.assertCreditLimit(user, dto.supplierId, grandTotal);
    }
    const invoiceNumber =
      dto.invoiceNumber?.trim() ||
      (await this.nextDocNumber(user.tenantId, isCredit ? 'SCN' : 'SINV'));

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supplierInvoice.create({
        data: {
          tenantId: user.tenantId,
          supplierId: dto.supplierId,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          goodsReceiptId: dto.goodsReceiptId ?? null,
          invoiceNumber,
          invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : new Date(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          subtotal: subtotal.toFixed(2),
          taxTotal: taxTotal.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          amountPaid: '0',
          status: isCredit ? 'credit' : 'open',
          notes: dto.notes?.trim() || null,
        },
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          goodsReceipt: { select: { id: true, grnNumber: true } },
        },
      });
      await this.accounting.postPurchaseInvoice(tx, user, created.id);
      return created;
    });
    return this.mapInvoice(row);
  }

  async createInvoiceFromGrn(user: AuthUser, grnId: string) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: grnId, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!grn) throw new NotFoundException('GRN not found');
    const existing = await this.prisma.supplierInvoice.findFirst({
      where: { tenantId: user.tenantId, goodsReceiptId: grnId },
    });
    if (existing) {
      throw new BadRequestException('Invoice already exists for this GRN');
    }
    const subtotal = grn.lines.reduce((s, l) => {
      const cost = l.unitCost != null ? Number(l.unitCost) : 0;
      return s + cost * Number(l.qty);
    }, 0);
    if (subtotal <= 0) {
      throw new BadRequestException(
        'GRN has no unit costs — create invoice manually with amounts',
      );
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { taxMode: true, taxId: true, settings: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    const taxProfile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId ?? null,
      settings: tenant.settings,
    });
    const { totalTax } = computeInvoiceTax(
      taxProfile,
      Number(subtotal.toFixed(2)),
    );
    return this.createInvoice(user, {
      supplierId: grn.supplierId,
      purchaseOrderId: grn.purchaseOrderId,
      goodsReceiptId: grn.id,
      subtotal: Number(subtotal.toFixed(2)),
      taxTotal: totalTax,
      notes: `From GRN ${grn.grnNumber}`,
    });
  }

  listInvoices(user: AuthUser, status?: string) {
    return this.prisma.supplierInvoice
      .findMany({
        where: {
          tenantId: user.tenantId,
          ...(status ? { status } : {}),
        },
        orderBy: { invoiceDate: 'desc' },
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          goodsReceipt: { select: { id: true, grnNumber: true } },
        },
      })
      .then((rows) => rows.map((r) => this.mapInvoice(r)));
  }

  listOutstanding(user: AuthUser) {
    return this.prisma.supplierInvoice
      .findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: ['open', 'partial', 'credit'] },
        },
        orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          goodsReceipt: { select: { id: true, grnNumber: true } },
        },
      })
      .then((rows) =>
        rows
          .map((r) => this.mapInvoice(r))
          .filter((r) => Math.abs(r.balanceDue) > 0.009),
      );
  }

  async payInvoice(
    user: AuthUser,
    invoiceId: string,
    dto: PaySupplierInvoiceDto,
  ) {
    const inv = await this.prisma.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
    });
    if (!inv) throw new NotFoundException('Supplier invoice not found');
    if (inv.status === 'void' || inv.status === 'paid') {
      throw new BadRequestException(`Invoice is ${inv.status}`);
    }

    const amount = Number(dto.amount);
    const paid = Number(inv.amountPaid);
    const total = Number(inv.grandTotal);
    const isCredit = inv.status === 'credit' || total < 0;
    const balance = isCredit
      ? Math.abs(total) - paid
      : total - paid;
    if (amount > balance + 1e-9) {
      throw new BadRequestException(
        `Payment ${amount.toFixed(2)} exceeds balance ${balance.toFixed(2)}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          tenantId: user.tenantId,
          supplierId: inv.supplierId,
          supplierInvoiceId: inv.id,
          amount: amount.toFixed(2),
          method: (dto.method?.trim() || 'bank_transfer').slice(0, 32),
          kind:
            dto.kind === 'refund' || isCredit
              ? 'refund'
              : 'payment',
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          actorUserId: user.userId,
        },
      });
      const nextPaid = Number((paid + amount).toFixed(2));
      const nextStatus =
        nextPaid + 1e-9 >= Math.abs(total)
          ? 'paid'
          : nextPaid > 0
            ? 'partial'
            : inv.status === 'credit'
              ? 'credit'
              : 'open';
      const updated = await tx.supplierInvoice.update({
        where: { id: inv.id },
        data: {
          amountPaid: nextPaid.toFixed(2),
          status: nextStatus,
        },
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          goodsReceipt: { select: { id: true, grnNumber: true } },
        },
      });
      await this.accounting.postSupplierPayment(tx, user, payment.id);
      return {
        invoice: this.mapInvoice(updated),
        payment: this.mapPayment(payment),
      };
    });
  }

  async createPayment(user: AuthUser, dto: CreateSupplierPaymentDto) {
    await this.getSupplier(user, dto.supplierId);
    if (dto.supplierInvoiceId) {
      return this.payInvoice(user, dto.supplierInvoiceId, {
        amount: dto.amount,
        method: dto.method,
        kind: dto.kind,
        reference: dto.reference,
        notes: dto.notes,
      });
    }
    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supplierPayment.create({
        data: {
          tenantId: user.tenantId,
          supplierId: dto.supplierId,
          amount: Number(dto.amount).toFixed(2),
          method: (dto.method?.trim() || 'bank_transfer').slice(0, 32),
          kind: dto.kind === 'refund' ? 'refund' : 'payment',
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          actorUserId: user.userId,
        },
      });
      await this.accounting.postSupplierPayment(tx, user, created.id);
      return created;
    });
    return { payment: this.mapPayment(payment) };
  }

  listPayments(user: AuthUser, supplierId?: string) {
    return this.prisma.supplierPayment
      .findMany({
        where: {
          tenantId: user.tenantId,
          ...(supplierId ? { supplierId } : {}),
        },
        orderBy: { paidAt: 'desc' },
        include: {
          supplier: { select: { id: true, name: true } },
          invoice: {
            select: { id: true, invoiceNumber: true, status: true },
          },
        },
      })
      .then((rows) => rows.map((r) => this.mapPayment(r)));
  }

  async supplierLedger(user: AuthUser, supplierId: string) {
    await this.getSupplier(user, supplierId);
    const [invoices, payments] = await Promise.all([
      this.prisma.supplierInvoice.findMany({
        where: { tenantId: user.tenantId, supplierId },
        orderBy: { invoiceDate: 'asc' },
      }),
      this.prisma.supplierPayment.findMany({
        where: { tenantId: user.tenantId, supplierId },
        orderBy: { paidAt: 'asc' },
      }),
    ]);

    type Entry = {
      at: string;
      kind: 'invoice' | 'credit' | 'payment' | 'supplier_refund';
      ref: string;
      debit: number;
      credit: number;
      note?: string | null;
    };
    const entries: Entry[] = [];
    for (const inv of invoices) {
      if (inv.status === 'void') continue;
      const total = Number(inv.grandTotal);
      const isCredit = inv.status === 'credit' || total < 0;
      entries.push({
        at: inv.invoiceDate.toISOString(),
        kind: isCredit ? 'credit' : 'invoice',
        ref: inv.invoiceNumber,
        debit: isCredit ? 0 : Math.abs(total),
        credit: isCredit ? Math.abs(total) : 0,
        note: inv.notes,
      });
    }
    for (const pay of payments) {
      const isRefund = pay.kind === 'refund';
      entries.push({
        at: pay.paidAt.toISOString(),
        kind: isRefund ? 'supplier_refund' : 'payment',
        ref: pay.reference || pay.id.slice(0, 8),
        // payment OUT reduces AP (credit); refund IN clears supplier credit (debit)
        debit: isRefund ? Number(pay.amount) : 0,
        credit: isRefund ? 0 : Number(pay.amount),
        note: pay.notes,
      });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));
    let balance = 0;
    const items = entries.map((e) => {
      balance = Number((balance + e.debit - e.credit).toFixed(2));
      return { ...e, balance };
    });
    return {
      supplierId,
      balance,
      items,
    };
  }

  private async nextDocNumber(
    tenantId: string,
    prefix: 'PO' | 'GRN' | 'SINV' | 'SCN',
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const year = new Date().getFullYear();
    const count =
      prefix === 'PO'
        ? await db.purchaseOrder.count({ where: { tenantId } })
        : prefix === 'GRN'
          ? await db.goodsReceipt.count({ where: { tenantId } })
          : await db.supplierInvoice.count({ where: { tenantId } });
    return `${prefix}-${year}-${String(count + 1).padStart(5, '0')}`;
  }

  private mapGrn(r: {
    id: string;
    grnNumber: string;
    supplierId: string;
    purchaseOrderId: string;
    notes: string | null;
    receivedAt: Date;
    supplier?: { id: string; name: string } | null;
    purchaseOrder?: {
      id: string;
      poNumber: string | null;
      status?: string;
    } | null;
    lines?: Array<{
      id: string;
      qty: unknown;
      unitCost: unknown;
      stockLevelId: string;
      stockLevel?: {
        id: string;
        sku: string;
        product?: { name: string } | null;
      } | null;
    }>;
  }) {
    return {
      id: r.id,
      grnNumber: r.grnNumber,
      supplierId: r.supplierId,
      purchaseOrderId: r.purchaseOrderId,
      notes: r.notes,
      receivedAt: r.receivedAt,
      supplier: r.supplier ?? undefined,
      purchaseOrder: r.purchaseOrder ?? undefined,
      lines: (r.lines ?? []).map((l) => ({
        id: l.id,
        stockLevelId: l.stockLevelId,
        qty: Number(l.qty),
        unitCost: l.unitCost != null ? Number(l.unitCost) : null,
        stockLevel: l.stockLevel ?? undefined,
      })),
    };
  }

  private mapInvoice(r: {
    id: string;
    supplierId: string;
    purchaseOrderId: string | null;
    goodsReceiptId: string | null;
    invoiceNumber: string;
    invoiceDate: Date;
    dueDate: Date | null;
    subtotal: unknown;
    taxTotal: unknown;
    grandTotal: unknown;
    amountPaid: unknown;
    status: string;
    notes: string | null;
    supplier?: { id: string; name: string } | null;
    purchaseOrder?: { id: string; poNumber: string | null } | null;
    goodsReceipt?: { id: string; grnNumber: string } | null;
  }) {
    const grandTotal = Number(r.grandTotal);
    const amountPaid = Number(r.amountPaid);
    const balanceDue =
      r.status === 'credit' || grandTotal < 0
        ? -(Math.abs(grandTotal) - amountPaid)
        : grandTotal - amountPaid;
    return {
      id: r.id,
      supplierId: r.supplierId,
      purchaseOrderId: r.purchaseOrderId,
      goodsReceiptId: r.goodsReceiptId,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.taxTotal),
      grandTotal,
      amountPaid,
      balanceDue: Number(balanceDue.toFixed(2)),
      status: r.status,
      notes: r.notes,
      supplier: r.supplier ?? undefined,
      purchaseOrder: r.purchaseOrder ?? undefined,
      goodsReceipt: r.goodsReceipt ?? undefined,
    };
  }

  private mapPayment(r: {
    id: string;
    supplierId: string;
    supplierInvoiceId?: string | null;
    amount: unknown;
    method: string;
    kind?: string;
    reference: string | null;
    notes: string | null;
    paidAt: Date;
    supplier?: { id: string; name: string } | null;
    invoice?: {
      id: string;
      invoiceNumber: string;
      status: string;
    } | null;
  }) {
    return {
      id: r.id,
      supplierId: r.supplierId,
      supplierInvoiceId: r.supplierInvoiceId ?? null,
      amount: Number(r.amount),
      method: r.method,
      kind: r.kind ?? 'payment',
      reference: r.reference,
      notes: r.notes,
      paidAt: r.paidAt,
      supplier: r.supplier ?? undefined,
      invoice: r.invoice ?? undefined,
    };
  }
}
