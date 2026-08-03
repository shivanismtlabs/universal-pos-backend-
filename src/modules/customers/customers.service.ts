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

    try {
      return await this.prisma.customer.create({
        data: {
          tenantId: user.tenantId,
          fullName: dto.fullName.trim(),
          phone,
          email: dto.email?.trim().toLowerCase(),
          eventDate: dto.eventDate ? new Date(dto.eventDate) : null,
          notes: dto.notes?.trim(),
          marketingOptIn,
          consentAt: marketingOptIn ? new Date() : null,
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
        measurements: {
          orderBy: { takenAt: 'desc' },
          take: 5,
        },
        partyMemberships: {
          include: {
            party: { select: { id: true, name: true, eventDate: true } },
          },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto) {
    await this.getById(user, id);

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

    const data: Prisma.CustomerUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase();
    if (dto.eventDate !== undefined) {
      data.eventDate = dto.eventDate ? new Date(dto.eventDate) : null;
    }
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.marketingOptIn !== undefined) {
      data.marketingOptIn = dto.marketingOptIn;
      data.consentAt = dto.marketingOptIn ? new Date() : null;
    }

    try {
      return await this.prisma.customer.update({
        where: { id },
        data,
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

  async softDelete(user: AuthUser, id: string) {
    const customer = await this.getById(user, id);
    // Free unique phone for reuse after soft delete
    const freedPhone = `${customer.phone}__del__${customer.id.slice(0, 8)}`;
    await this.prisma.customer.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        phone: freedPhone,
        marketingOptIn: false,
      },
    });
    return null;
  }

  async addMeasurement(
    user: AuthUser,
    customerId: string,
    dto: CreateMeasurementDto,
  ) {
    await this.getById(user, customerId);

    return this.prisma.customerMeasurement.create({
      data: {
        tenantId: user.tenantId,
        customerId,
        heightCm: dto.heightCm?.toString(),
        weightKg: dto.weightKg?.toString(),
        chest: dto.chest?.toString(),
        waist: dto.waist?.toString(),
        inseam: dto.inseam?.toString(),
        sleeve: dto.sleeve?.toString(),
        shoeSize: dto.shoeSize,
        takenByUserId: user.userId,
      },
    });
  }

  async listMeasurements(user: AuthUser, customerId: string) {
    await this.getById(user, customerId);
    return this.prisma.customerMeasurement.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: { takenAt: 'desc' },
    });
  }

  async createParty(user: AuthUser, dto: CreatePartyDto) {
    if (dto.primaryCustomerId) {
      await this.getById(user, dto.primaryCustomerId);
    }

    const memberIds = dto.members?.map((m) => m.customerId) ?? [];
    for (const id of memberIds) {
      await this.getById(user, id);
    }

    return this.prisma.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          eventDate: dto.eventDate ? new Date(dto.eventDate) : null,
          primaryCustomerId: dto.primaryCustomerId,
        },
      });

      if (dto.members?.length) {
        await tx.partyMember.createMany({
          data: dto.members.map((m) => ({
            partyId: party.id,
            customerId: m.customerId,
            roleLabel: m.roleLabel,
          })),
          skipDuplicates: true,
        });
      }

      if (dto.primaryCustomerId && !memberIds.includes(dto.primaryCustomerId)) {
        await tx.partyMember.create({
          data: {
            partyId: party.id,
            customerId: dto.primaryCustomerId,
            roleLabel: 'primary',
          },
        });
      }

      return tx.party.findFirst({
        where: { id: party.id },
        include: {
          members: { include: { customer: true } },
          primaryCustomer: true,
        },
      });
    });
  }

  async listParties(user: AuthUser) {
    return this.prisma.party.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        primaryCustomer: {
          select: { id: true, fullName: true, phone: true },
        },
        members: {
          include: {
            customer: { select: { id: true, fullName: true, phone: true } },
          },
        },
      },
    });
  }

  async getParty(user: AuthUser, id: string) {
    const party = await this.prisma.party.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        primaryCustomer: true,
        members: { include: { customer: true } },
      },
    });
    if (!party) {
      throw new NotFoundException('Party not found');
    }
    return party;
  }

  async addPartyMember(
    user: AuthUser,
    partyId: string,
    dto: AddPartyMemberDto,
  ) {
    await this.getParty(user, partyId);
    await this.getById(user, dto.customerId);

    try {
      await this.prisma.partyMember.create({
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
        throw new ConflictException('Customer already in this party');
      }
      throw e;
    }

    return this.getParty(user, partyId);
  }

  async removePartyMember(user: AuthUser, partyId: string, customerId: string) {
    await this.getParty(user, partyId);
    await this.prisma.partyMember.deleteMany({
      where: { partyId, customerId },
    });
    return this.getParty(user, partyId);
  }
}
