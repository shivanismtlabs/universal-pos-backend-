import {
  BadRequestException,
  Injectable,
  Logger,
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
    `Hi ${String(v.customerName ?? 'there')}, your order ${String(v.orderNumber ?? '')} is ready for pickup. See you soon!`,
  fitting_reminder: (v) =>
    `Reminder: your appointment${v.startsAt ? ` at ${String(v.startsAt)}` : ''} is coming up.`,
  payment_received: (v) =>
    `Payment of ₹${String(v.amount ?? '')} received for ${String(v.orderNumber ?? 'your order')}. Thank you!`,
  return_due: (v) =>
    `Gentle reminder: return for ${String(v.orderNumber ?? 'your rental')} is due${v.returnDueDate ? ` on ${String(v.returnDueDate)}` : ''}.`,
  sale_receipt: (v) =>
    `Hi ${String(v.customerName ?? 'there')}, thank you for shopping at ${String(v.storeName ?? 'our store')}. Invoice ${String(v.orderNumber ?? '')} total ${String(v.total ?? '')}${v.balanceDue && Number(v.balanceDue) > 0 ? ` (balance due ${String(v.balanceDue)})` : ' (paid)'}.`,
  custom: (v) => String(v.message ?? v.text ?? '').trim(),
};

@Injectable()
export class NotifyService {
  private readonly log = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gupshup: GupshupWhatsAppProvider,
  ) {}

  getConfig() {
    return {
      ...this.gupshup.getStatus(),
      channels: {
        whatsapp: true,
        sms: true,
        email: true,
        note: 'SMS/email use mock delivery until provider keys are set',
      },
    };
  }

  async send(user: AuthUser, dto: SendNotificationDto) {
    if (
      dto.channel !== NotificationChannel.whatsapp &&
      dto.channel !== NotificationChannel.sms &&
      dto.channel !== NotificationChannel.email
    ) {
      throw new BadRequestException('Unsupported notification channel');
    }

    let phone = dto.phone?.trim() ?? '';
    let email = dto.email?.trim() ?? '';
    let customerName = '';
    let customerId = dto.customerId;

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId: user.tenantId, deletedAt: null },
        select: { id: true, phone: true, fullName: true, email: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      if (!phone) phone = customer.phone;
      if (!email) email = customer.email?.trim() ?? '';
      customerName = customer.fullName;
      customerId = customer.id;
    }

    if (dto.channel === NotificationChannel.email) {
      if (!email) {
        throw new BadRequestException(
          'Provide customerId with email or email field',
        );
      }
    } else if (!phone) {
      throw new BadRequestException(
        'Provide customerId or phone to send SMS/WhatsApp',
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

    const destination =
      dto.channel === NotificationChannel.email
        ? email
        : this.gupshup.normalizePhone(phone);

    const log = await this.prisma.notificationLog.create({
      data: {
        tenantId: user.tenantId,
        customerId,
        channel: dto.channel,
        templateKey: dto.templateKey,
        payload: {
          ...vars,
          renderedText: text,
          destination,
        } as Prisma.InputJsonValue,
        status: 'queued',
      },
    });

    try {
      if (dto.channel === NotificationChannel.whatsapp) {
        const result = await this.gupshup.sendText(phone, text);
        return this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            status: result.mode === 'mock' ? 'sent_mock' : 'sent',
            payload: {
              ...vars,
              renderedText: text,
              destination,
              providerMode: result.mode,
              providerMessageId: result.providerMessageId,
              providerRaw: result.raw ?? null,
            } as Prisma.InputJsonValue,
          },
        });
      }

      // SMS / email — mock delivery (logged); wire provider later
      this.log.log(
        `[${dto.channel}] mock send → ${destination}: ${text.slice(0, 120)}`,
      );
      return this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: 'sent_mock',
          payload: {
            ...vars,
            renderedText: text,
            destination,
            providerMode: 'mock',
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
            destination,
            error: message,
          } as Prisma.InputJsonValue,
        },
      });
      throw e;
    }
  }

  /** Best-effort sale receipt notify (does not throw to caller) */
  async sendSaleReceipt(
    user: AuthUser,
    args: {
      customerId?: string | null;
      orderNumber: string;
      total: string;
      balanceDue: string;
      storeName?: string;
      channels?: Array<'email' | 'sms' | 'whatsapp'>;
    },
  ) {
    if (!args.customerId) return [];
    const channels = args.channels?.length
      ? args.channels
      : (['email', 'sms'] as const);
    const results = [];
    for (const channel of channels) {
      try {
        const row = await this.send(user, {
          customerId: args.customerId,
          channel: channel as NotificationChannel,
          templateKey: 'sale_receipt',
          payload: {
            orderNumber: args.orderNumber,
            total: args.total,
            balanceDue: args.balanceDue,
            storeName: args.storeName,
          },
        });
        results.push(row);
      } catch (e) {
        this.log.warn(
          `sale_receipt ${channel} failed: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    return results;
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
