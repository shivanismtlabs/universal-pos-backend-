import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomFieldEntity, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateCustomFieldDefinitionDto,
  ListCustomFieldDefinitionsQueryDto,
  UpsertCustomFieldValueDto,
} from './dto/custom-fields.dto';

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async listDefinitions(
    user: AuthUser,
    query: ListCustomFieldDefinitionsQueryDto,
  ) {
    const rows = await this.prisma.customFieldDefinition.findMany({
      where: {
        tenantId: user.tenantId,
        ...(query.entity ? { entity: query.entity } : {}),
      },
      orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });
    return { data: rows };
  }

  async createDefinition(user: AuthUser, dto: CreateCustomFieldDefinitionDto) {
    try {
      const row = await this.prisma.customFieldDefinition.create({
        data: {
          tenantId: user.tenantId,
          entity: dto.entity,
          fieldKey: dto.fieldKey.trim().toLowerCase(),
          label: dto.label.trim(),
          dataType: dto.dataType.trim().toLowerCase(),
          required: dto.required ?? false,
          options: (dto.options ?? []) as Prisma.InputJsonValue,
          moduleCode: dto.moduleCode,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return row;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Field key already exists for entity');
      }
      throw e;
    }
  }

  async upsertValue(user: AuthUser, dto: UpsertCustomFieldValueDto) {
    const def = await this.prisma.customFieldDefinition.findFirst({
      where: { id: dto.definitionId, tenantId: user.tenantId },
    });
    if (!def) throw new NotFoundException('Custom field definition not found');

    const row = await this.prisma.customFieldValue.upsert({
      where: {
        definitionId_entityId: {
          definitionId: dto.definitionId,
          entityId: dto.entityId,
        },
      },
      create: {
        tenantId: user.tenantId,
        definitionId: dto.definitionId,
        entityId: dto.entityId,
        valueText: dto.valueText,
        valueNumber:
          dto.valueNumber != null
            ? new Prisma.Decimal(dto.valueNumber)
            : undefined,
        valueJson:
          dto.valueJson !== undefined
            ? (dto.valueJson as Prisma.InputJsonValue)
            : undefined,
      },
      update: {
        valueText: dto.valueText,
        valueNumber:
          dto.valueNumber != null
            ? new Prisma.Decimal(dto.valueNumber)
            : null,
        valueJson:
          dto.valueJson !== undefined
            ? (dto.valueJson as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
    return row;
  }

  async listValuesForEntity(
    user: AuthUser,
    entity: CustomFieldEntity,
    entityId: string,
  ) {
    const defs = await this.prisma.customFieldDefinition.findMany({
      where: { tenantId: user.tenantId, entity },
      include: {
        values: {
          where: { entityId, tenantId: user.tenantId },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      data: defs.map((d) => ({
        definition: {
          id: d.id,
          entity: d.entity,
          fieldKey: d.fieldKey,
          label: d.label,
          dataType: d.dataType,
          required: d.required,
          options: d.options,
        },
        value: d.values[0]
          ? {
              id: d.values[0].id,
              valueText: d.values[0].valueText,
              valueNumber:
                d.values[0].valueNumber != null
                  ? Number(d.values[0].valueNumber)
                  : null,
              valueJson: d.values[0].valueJson,
            }
          : null,
      })),
    };
  }
}
