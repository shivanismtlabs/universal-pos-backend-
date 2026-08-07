import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateCustomerDto) {
    const phone = dto.phone.trim();
    const existing = await this.prisma.customer.findFirst({
      where: { tenantId: user.tenantId, phone, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException('Customer with this phone already exists');
    }

    const marketingOptIn = dto.marketingOptIn ?? false;
    const meta: Record<string, unknown> = {};
    if (dto.eventDate) meta.eventDate = dto.eventDate;

    try {
      return await this.prisma.customer.create({
        data: {
          tenantId: user.tenantId,
          fullName: dto.fullName.trim(),
          phone,
          email: dto.email?.trim().toLowerCase(),
          notes: dto.notes?.trim(),
          marketingOptIn,
          consentAt: marketingOptIn ? new Date() : null,
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

    const where: Prisma.CustomerWhereInput = {
      tenantId: user.tenantId,
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
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
    return {
      ...rest,
      measurements: rentalMeasurements,
      partyMemberships: rentalPartyMemberships,
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

    const data: Prisma.CustomerUpdateInput = {
      meta: meta as Prisma.InputJsonValue,
    };
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase();
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.marketingOptIn !== undefined) {
      data.marketingOptIn = dto.marketingOptIn;
      data.consentAt = dto.marketingOptIn ? new Date() : null;
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
    await this.getById(user, id);
    await this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
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
