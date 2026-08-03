import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { ListNotifyLogsQueryDto, SendNotificationDto } from './dto/notify.dto';
import { GupshupWhatsAppProvider } from './gupshup.provider';

const TEMPLATES: Record<
  string,
  (vars: Record<string, unknown>) => string
> = {
  order_ready_for_pickup: (v) =>
    `Hi ${String(v.customerName ?? 'there')}, your order ${String(v.orderNumber ?? '')} is ready for pickup at Tuxedo. See you soon!`,
  fitting_reminder: (v) =>
    `Reminder: fitting for ${String(v.customerName ?? 'you')} is scheduled${v.startsAt ? ` at ${String(v.startsAt)}` : ''}. — Tuxedo`,
  payment_received: (v) =>
    `Payment of ₹${String(v.amount ?? '')} received for ${String(v.orderNumber ?? 'your order')}. Thank you! — Tuxedo`,
  return_due: (v) =>
    `Gentle reminder: return for ${String(v.orderNumber ?? 'your rental')} is due${v.returnDueDate ? ` on ${String(v.returnDueDate)}` : ''}. — Tuxedo`,
  custom: (v) => String(v.message ?? v.text ?? '').trim(),
};

@Injectable()
export class NotifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gupshup: GupshupWhatsAppProvider,
  ) {}

  getConfig() {
    return this.gupshup.getStatus();
  }

  async send(user: AuthUser, dto: SendNotificationDto) {
    if (dto.channel !== NotificationChannel.whatsapp) {
      throw new BadRequestException(
        'Only WhatsApp channel is wired right now (sms/email coming later)',
      );
    }

    let phone = dto.phone?.trim() ?? '';
    let customerName = '';

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId: user.tenantId, deletedAt: null },
        select: { id: true, phone: true, fullName: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      if (!phone) phone = customer.phone;
      customerName = customer.fullName;
    }

    if (!phone) {
      throw new BadRequestException(
        'Provide customerId or phone to send WhatsApp',
      );
    }

    const vars: Record<string, unknown> = {
      customerName,
      ...(dto.payload ?? {}),
    };
    if (!vars.customerName) vars.customerName = customerName || 'there';

    const builder = TEMPLATES[dto.templateKey] ?? TEMPLATES.custom;
    const text = builder(vars);
    if (!text) {
      throw new BadRequestException(
        'Empty message. Use a known templateKey or payload.message',
      );
    }

    const log = await this.prisma.notificationLog.create({
      data: {
        tenantId: user.tenantId,
        customerId: dto.customerId,
        channel: dto.channel,
        templateKey: dto.templateKey,
        payload: {
          ...vars,
          renderedText: text,
          destination: this.gupshup.normalizePhone(phone),
        } as Prisma.InputJsonValue,
        status: 'queued',
      },
    });

    try {
      const result = await this.gupshup.sendText(phone, text);
      return this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: result.mode === 'mock' ? 'sent_mock' : 'sent',
          payload: {
            ...vars,
            renderedText: text,
            destination: this.gupshup.normalizePhone(phone),
            providerMode: result.mode,
            providerMessageId: result.providerMessageId,
            providerRaw: result.raw ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Send failed';
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: 'failed',
          payload: {
            ...vars,
            renderedText: text,
            destination: this.gupshup.normalizePhone(phone),
            error: message,
          } as Prisma.InputJsonValue,
        },
      });
      throw e;
    }
  }

  async listLogs(user: AuthUser, query: ListNotifyLogsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.NotificationLogWhereInput = {
      tenantId: user.tenantId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, fullName: true, phone: true } },
        },
      }),
      this.prisma.notificationLog.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }
}
