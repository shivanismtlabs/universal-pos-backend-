import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  AddPartyMemberDto,
  CreateCustomerDto,
  CreateMeasurementDto,
  CreatePartyDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customers.dto';
import {
  canonicalPhone,
  phoneDigits,
  phoneLookupVariants,
} from '../payments/phone-normalize';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateCustomerDto) {
    const variants = phoneLookupVariants(dto.phone);
    const existing = await this.prisma.customer.findFirst({
      where: {
        tenantId: user.tenantId,
        deletedAt: null,
        phone: { in: variants },
      },
    });
    if (existing) {
      if (dto.returnExisting) return existing;
      throw new ConflictException('Customer with this phone already exists');
    }

    const phone = canonicalPhone(dto.phone);

    const marketingOptIn = dto.marketingOptIn ?? false;
    const meta: Record<string, unknown> = {};
    if (dto.eventDate) meta.eventDate = dto.eventDate;
    if (dto.extraFields && typeof dto.extraFields === 'object') {
      meta.customFields = dto.extraFields;
    }

    try {
      return await this.prisma.customer.create({
        data: {
          tenantId: user.tenantId,
          fullName: dto.fullName.trim(),
          phone,
          email: dto.email?.trim().toLowerCase(),
          notes: dto.notes?.trim(),
          dateOfBirth: dto.dateOfBirth
            ? new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`)
            : null,
          marketingOptIn,
          consentAt: marketingOptIn ? new Date() : null,
          creditLimit:
            dto.creditLimit === undefined || dto.creditLimit === null
              ? null
              : dto.creditLimit,
          meta: meta as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Customer with this phone already exists');
      }
      throw e;
    }
  }

  async list(user: AuthUser, query: ListCustomersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const q = query.q?.trim();
    const qDigits = q ? phoneDigits(q) : '';
    const phoneVariants = q ? phoneLookupVariants(q) : [];

    const where: Prisma.CustomerWhereInput = {
      tenantId: user.tenantId,
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              ...(qDigits.length >= 7
                ? [
                    { phone: { in: phoneVariants } },
                    { phone: { contains: qDigits.slice(-10) } },
                  ]
                : []),
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getById(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      include: {
        rentalMeasurements: { orderBy: { takenAt: 'desc' }, take: 5 },
        rentalPartyMemberships: {
          include: {
            party: { select: { id: true, name: true, eventDate: true } },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const { rentalMeasurements, rentalPartyMemberships, ...rest } = customer;
    const meta = (rest.meta as Record<string, unknown>) ?? {};

    const [orderAgg, dueAgg, noteCount, spentAgg, lastVisit, activeMembership] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: { tenantId: user.tenantId, customerId: id },
          _count: { _all: true },
        }),
        this.prisma.order.aggregate({
          where: {
            tenantId: user.tenantId,
            customerId: id,
            balanceDue: { gt: 0 },
          },
          _sum: { balanceDue: true },
          _count: { _all: true },
        }),
        this.prisma.customerNote.count({
          where: { tenantId: user.tenantId, customerId: id },
        }),
        this.prisma.order.aggregate({
          where: {
            tenantId: user.tenantId,
            customerId: id,
            status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
          },
          _sum: { subtotal: true, taxTotal: true, discountTotal: true },
        }),
        this.prisma.order.findFirst({
          where: {
            tenantId: user.tenantId,
            customerId: id,
            status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, orderNumber: true },
        }),
        this.prisma.customerSubscription.findFirst({
          where: {
            tenantId: user.tenantId,
            customerId: id,
            status: 'active',
          },
          include: {
            product: { select: { id: true, name: true } },
          },
          orderBy: { currentPeriodEnd: 'desc' },
        }),
      ]);

    const totalSpent = Math.max(
      0,
      Number(spentAgg._sum.subtotal ?? 0) +
        Number(spentAgg._sum.taxTotal ?? 0) -
        Number(spentAgg._sum.discountTotal ?? 0),
    );
    const openDueTotal = Number(dueAgg._sum.balanceDue ?? 0);
    const creditLimit =
      rest.creditLimit == null ? null : Number(rest.creditLimit);
    const availableCredit =
      creditLimit == null
        ? null
        : Math.max(0, Math.round((creditLimit - openDueTotal) * 100) / 100);

    return {
      ...rest,
      creditLimit,
      eventDate:
        typeof meta.eventDate === 'string' ? meta.eventDate : null,
      extraFields:
        meta.customFields && typeof meta.customFields === 'object'
          ? (meta.customFields as Record<string, unknown>)
          : {},
      measurements: rentalMeasurements,
      partyMemberships: rentalPartyMemberships,
      summary: {
        orderCount: orderAgg._count._all,
        openDueCount: dueAgg._count._all,
        openDueTotal,
        loyaltyPoints: rest.loyaltyPoints,
        storeCreditBalance: Number(rest.storeCreditBalance),
        noteCount,
        totalSpent: Math.round(totalSpent * 100) / 100,
        lastVisitAt: lastVisit?.createdAt ?? null,
        lastVisitOrder: lastVisit?.orderNumber ?? null,
        creditLimit,
        availableCredit,
        activeMembership: activeMembership
          ? {
              id: activeMembership.id,
              status: activeMembership.status,
              planName: activeMembership.product.name,
              productId: activeMembership.productId,
              currentPeriodEnd: activeMembership.currentPeriodEnd,
              price: Number(activeMembership.price),
            }
          : null,
      },
    };
  }

  async listOrders(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        orderNumber: true,
        kind: true,
        status: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
        balanceDue: true,
        currencyCode: true,
        createdAt: true,
      },
    });
    return {
      items: rows.map((o) => ({
        ...o,
        subtotal: Number(o.subtotal),
        taxTotal: Number(o.taxTotal),
        discountTotal: Number(o.discountTotal),
        balanceDue: Number(o.balanceDue),
        grandTotal:
          Number(o.subtotal) +
          Number(o.taxTotal) -
          Number(o.discountTotal),
      })),
    };
  }

  async listDues(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        customerId,
        balanceDue: { gt: 0 },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        orderNumber: true,
        kind: true,
        status: true,
        balanceDue: true,
        currencyCode: true,
        createdAt: true,
      },
    });
    const totalDue = rows.reduce((s, o) => s + Number(o.balanceDue), 0);
    return {
      totalDue,
      items: rows.map((o) => ({
        ...o,
        balanceDue: Number(o.balanceDue),
      })),
    };
  }

  async listPayments(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.payment.findMany({
      where: {
        tenantId: user.tenantId,
        order: { customerId },
        status: 'succeeded',
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        type: true,
        method: true,
        amount: true,
        createdAt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            kind: true,
            status: true,
          },
        },
      },
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        type: p.type,
        method: p.method,
        amount: Number(p.amount),
        createdAt: p.createdAt,
        orderId: p.order.id,
        orderNumber: p.order.orderNumber,
        orderKind: p.order.kind,
        orderStatus: p.order.status,
      })),
    };
  }

  async listMemberships(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.customerSubscription.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        product: { select: { id: true, name: true, skuCode: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        billingPeriodDays: r.billingPeriodDays,
        price: Number(r.price),
        startsAt: r.startsAt,
        currentPeriodStart: r.currentPeriodStart,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelledAt: r.cancelledAt,
        product: r.product,
      })),
    };
  }

  /** Virtual timeline — notes + loyalty + wallet + orders + payments (no new table) */
  async listActivity(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 100);
    const perSource = Math.min(40, take);

    const [notes, loyalty, wallet, orders, payments] = await Promise.all([
      this.prisma.customerNote.findMany({
        where: { tenantId: user.tenantId, customerId },
        orderBy: { createdAt: 'desc' },
        take: perSource,
        include: { createdBy: { select: { fullName: true } } },
      }),
      this.prisma.loyaltyLedgerEntry.findMany({
        where: { tenantId: user.tenantId, customerId },
        orderBy: { createdAt: 'desc' },
        take: perSource,
      }),
      this.prisma.storeCreditLedgerEntry.findMany({
        where: { tenantId: user.tenantId, customerId },
        orderBy: { createdAt: 'desc' },
        take: perSource,
      }),
      this.prisma.order.findMany({
        where: { tenantId: user.tenantId, customerId },
        orderBy: { createdAt: 'desc' },
        take: perSource,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          kind: true,
          subtotal: true,
          taxTotal: true,
          discountTotal: true,
          balanceDue: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.findMany({
        where: {
          tenantId: user.tenantId,
          order: { customerId },
          status: 'succeeded',
        },
        orderBy: { createdAt: 'desc' },
        take: perSource,
        select: {
          id: true,
          type: true,
          method: true,
          amount: true,
          createdAt: true,
          order: { select: { id: true, orderNumber: true } },
        },
      }),
    ]);

    type ActivityItem = {
      id: string;
      kind: string;
      title: string;
      detail: string | null;
      amount: number | null;
      createdAt: Date;
      href?: string | null;
    };

    const items: ActivityItem[] = [];

    for (const n of notes) {
      items.push({
        id: `note:${n.id}`,
        kind: 'note',
        title: 'Note',
        detail: n.body,
        amount: null,
        createdAt: n.createdAt,
      });
    }
    for (const l of loyalty) {
      items.push({
        id: `loyalty:${l.id}`,
        kind: `loyalty_${l.kind}`,
        title: `Loyalty ${l.kind}`,
        detail: l.note,
        amount: l.points,
        createdAt: l.createdAt,
        href: l.orderId ? `/orders/view?id=${l.orderId}` : null,
      });
    }
    for (const w of wallet) {
      items.push({
        id: `wallet:${w.id}`,
        kind: `wallet_${w.kind}`,
        title: `Wallet ${w.kind}`,
        detail: w.note,
        amount: Number(w.amount),
        createdAt: w.createdAt,
        href: w.orderId ? `/orders/view?id=${w.orderId}` : null,
      });
    }
    for (const o of orders) {
      const total =
        Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal);
      items.push({
        id: `order:${o.id}`,
        kind: 'order',
        title: `Order ${o.orderNumber}`,
        detail: `${o.kind} · ${o.status}`,
        amount: total,
        createdAt: o.createdAt,
        href: `/orders/view?id=${o.id}`,
      });
    }
    for (const p of payments) {
      items.push({
        id: `payment:${p.id}`,
        kind: `payment_${p.type}`,
        title: `${p.type} · ${p.method}`,
        detail: p.order.orderNumber,
        amount: Number(p.amount),
        createdAt: p.createdAt,
        href: `/orders/view?id=${p.order.id}`,
      });
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: items.slice(0, take) };
  }

  async listLoyaltyLedger(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.loyaltyLedgerEntry.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return { items: rows };
  }

  async listStoreCreditLedger(
    user: AuthUser,
    customerId: string,
    limit = 50,
  ) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.storeCreditLedgerEntry.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { id: true, fullName: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        amount: Number(r.amount),
        balanceAfter: Number(r.balanceAfter),
        orderId: r.orderId,
        note: r.note,
        createdAt: r.createdAt,
        actorName: r.actor?.fullName ?? null,
      })),
    };
  }

  async adjustStoreCredit(
    user: AuthUser,
    customerId: string,
    amount: number,
    note?: string,
  ) {
    if (!Number.isFinite(amount) || amount === 0) {
      throw new ConflictException('Amount must be a non-zero number');
    }
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const current = Number(customer.storeCreditBalance);
    const next = Math.round((current + amount) * 100) / 100;
    if (next < -1e-9) {
      throw new ConflictException(
        `Insufficient store credit (have ${current.toFixed(2)})`,
      );
    }

    const kind = amount > 0 ? 'credit' : 'debit';
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.customer.update({
        where: { id: customerId },
        data: { storeCreditBalance: next.toFixed(2) },
      });
      await tx.storeCreditLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          customerId,
          kind,
          amount: Math.abs(amount).toFixed(2),
          balanceAfter: next.toFixed(2),
          note: note?.trim() || (amount > 0 ? 'Wallet top-up' : 'Wallet debit'),
          actorUserId: user.userId,
        },
      });
      return row;
    });

    return {
      customerId,
      storeCreditBalance: Number(updated.storeCreditBalance),
      amount,
      kind,
    };
  }

  async listNotes(user: AuthUser, customerId: string, limit = 50) {
    await this.assertCustomer(user.tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.customerNote.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        createdBy: { select: { id: true, fullName: true } },
      },
    });
    return {
      items: rows.map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.createdAt,
        createdByName: n.createdBy?.fullName ?? null,
      })),
    };
  }

  async addNote(user: AuthUser, customerId: string, body: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const text = body.trim();
    if (!text) throw new ConflictException('Note body is required');

    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customerNote.create({
        data: {
          tenantId: user.tenantId,
          customerId,
          body: text,
          createdById: user.userId,
        },
        include: {
          createdBy: { select: { id: true, fullName: true } },
        },
      });
      // Keep legacy summary field as latest note preview
      await tx.customer.update({
        where: { id: customerId },
        data: { notes: text.slice(0, 2000) },
      });
      return created;
    });

    return {
      id: note.id,
      body: note.body,
      createdAt: note.createdAt,
      createdByName: note.createdBy?.fullName ?? null,
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto) {
    const current = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
    });
    if (!current) throw new NotFoundException('Customer not found');

    if (dto.phone) {
      const clash = await this.prisma.customer.findFirst({
        where: {
          tenantId: user.tenantId,
          phone: dto.phone.trim(),
          deletedAt: null,
          NOT: { id },
        },
      });
      if (clash) {
        throw new ConflictException('Customer with this phone already exists');
      }
    }

    const meta = {
      ...((current.meta as Record<string, unknown>) ?? {}),
    };
    if (dto.eventDate !== undefined) {
      if (dto.eventDate) meta.eventDate = dto.eventDate;
      else delete meta.eventDate;
    }
    if (dto.extraFields && typeof dto.extraFields === 'object') {
      meta.customFields = dto.extraFields;
    }

    const data: Prisma.CustomerUpdateInput = {
      meta: meta as Prisma.InputJsonValue,
    };
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase();
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.dateOfBirth !== undefined) {
      data.dateOfBirth = dto.dateOfBirth
        ? new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`)
        : null;
    }
    if (dto.marketingOptIn !== undefined) {
      data.marketingOptIn = dto.marketingOptIn;
      data.consentAt = dto.marketingOptIn ? new Date() : null;
    }
    if (dto.creditLimit !== undefined) {
      data.creditLimit =
        dto.creditLimit === null ? null : dto.creditLimit;
    }

    try {
      return await this.prisma.customer.update({ where: { id }, data });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Customer with this phone already exists');
      }
      throw e;
    }
  }

  async softDelete(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      select: { id: true, phone: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    // Free tenant+phone unique so the number can be re-created after soft-delete
    const freedPhone = `${customer.phone}#deleted#${id.replace(/-/g, '').slice(0, 12)}`;

    await this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date(), phone: freedPhone },
    });
    return { id, deleted: true };
  }

  async addMeasurement(
    user: AuthUser,
    customerId: string,
    dto: CreateMeasurementDto,
  ) {
    await this.assertCustomer(user.tenantId, customerId);
    return this.prisma.modRentalMeasurement.create({
      data: {
        tenantId: user.tenantId,
        customerId,
        heightCm: dto.heightCm,
        weightKg: dto.weightKg,
        chest: dto.chest,
        waist: dto.waist,
        inseam: dto.inseam,
        sleeve: dto.sleeve,
        shoeSize: dto.shoeSize,
        takenByUserId: user.userId,
      },
    });
  }

  async listMeasurements(user: AuthUser, customerId: string) {
    await this.assertCustomer(user.tenantId, customerId);
    return this.prisma.modRentalMeasurement.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { takenAt: 'desc' },
    });
  }

  async createParty(user: AuthUser, dto: CreatePartyDto) {
    if (dto.primaryCustomerId) {
      await this.assertCustomer(user.tenantId, dto.primaryCustomerId);
    }
    for (const m of dto.members ?? []) {
      await this.assertCustomer(user.tenantId, m.customerId);
    }

    return this.prisma.modRentalParty.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
        eventDate: dto.eventDate ? new Date(dto.eventDate) : null,
        primaryCustomerId: dto.primaryCustomerId,
        members: dto.members?.length
          ? {
              create: dto.members.map((m) => ({
                customerId: m.customerId,
                roleLabel: m.roleLabel,
              })),
            }
          : undefined,
      },
      include: {
        primaryCustomer: {
          select: { id: true, fullName: true, phone: true },
        },
        members: {
          include: {
            customer: {
              select: { id: true, fullName: true, phone: true },
            },
          },
        },
      },
    });
  }

  listParties(user: AuthUser) {
    return this.prisma.modRentalParty.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        primaryCustomer: {
          select: { id: true, fullName: true, phone: true },
        },
        members: {
          include: {
            customer: {
              select: { id: true, fullName: true, phone: true },
            },
          },
        },
      },
    });
  }

  async getParty(user: AuthUser, id: string) {
    const party = await this.prisma.modRentalParty.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        primaryCustomer: true,
        members: {
          include: {
            customer: {
              select: { id: true, fullName: true, phone: true },
            },
          },
        },
      },
    });
    if (!party) throw new NotFoundException('Party not found');
    return party;
  }

  async addPartyMember(
    user: AuthUser,
    partyId: string,
    dto: AddPartyMemberDto,
  ) {
    await this.getParty(user, partyId);
    await this.assertCustomer(user.tenantId, dto.customerId);
    try {
      await this.prisma.modRentalPartyMember.create({
        data: {
          partyId,
          customerId: dto.customerId,
          roleLabel: dto.roleLabel,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Member already in party');
      }
      throw e;
    }
    return this.getParty(user, partyId);
  }

  async removePartyMember(
    user: AuthUser,
    partyId: string,
    customerId: string,
  ) {
    await this.getParty(user, partyId);
    await this.prisma.modRentalPartyMember.deleteMany({
      where: { partyId, customerId },
    });
    return { partyId, customerId, removed: true };
  }

  private async assertCustomer(tenantId: string, id: string) {
    const c = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Customer not found');
  }
}
