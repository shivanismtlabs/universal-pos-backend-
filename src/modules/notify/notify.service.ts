import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  ListNotifyLogsQueryDto,
  SendInvoiceDto,
  SendNotificationDto,
} from './dto/notify.dto';
import { GupshupWhatsAppProvider } from './gupshup.provider';
import { MailService } from '../mail/mail.service';

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
  sale_invoice: (v) =>
    `Hi ${String(v.customerName ?? 'there')}, here is your invoice ${String(v.orderNumber ?? '')} from ${String(v.storeName ?? 'our store')}.\nSubtotal: ${String(v.subtotal ?? '')}\nTax: ${String(v.taxTotal ?? '')}\nTotal: ${String(v.total ?? '')}${v.balanceDue && Number(v.balanceDue) > 0 ? `\nBalance due: ${String(v.balanceDue)}` : '\nStatus: Paid'}.\nThank you!`,
  birthday_wish: (v) =>
    `Happy Birthday ${String(v.customerName ?? '')}! 🎉 Wishing you a wonderful year from ${String(v.storeName ?? 'all of us')}.`,
  custom: (v) => String(v.message ?? v.text ?? v.body ?? '').trim(),
  scheduled_report: (v) =>
    String(v.message ?? v.body ?? v.text ?? '').trim(),
  monthly_sales_report: (v) =>
    String(v.message ?? v.body ?? v.text ?? '').trim(),
};

@Injectable()
export class NotifyService {
  private readonly log = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gupshup: GupshupWhatsAppProvider,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  getConfig() {
    const emailWebhook = Boolean(
      this.config.get<string>('EMAIL_WEBHOOK_URL')?.trim(),
    );
    const smtp = this.mail.isConfigured();
    const smsWebhook = Boolean(
      this.config.get<string>('SMS_WEBHOOK_URL')?.trim(),
    );
    const emailMode = smtp ? 'smtp' : emailWebhook ? 'webhook' : 'mock';
    return {
      ...this.gupshup.getStatus(),
      channels: {
        whatsapp: true,
        sms: true,
        email: true,
        emailMode,
        smsMode: smsWebhook ? 'webhook' : 'mock',
        note: smtp
          ? 'Email via SMTP'
          : emailWebhook
            ? 'Email via EMAIL_WEBHOOK_URL'
            : 'Email mock until SMTP_HOST/SMTP_USER/SMTP_PASS (or EMAIL_WEBHOOK_URL) is set; SMS mock until SMS_WEBHOOK_URL',
      },
      birthdayReminders: {
        optional: true,
        requiresMarketingOptIn: true,
        templateKey: 'birthday_wish',
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

      if (dto.channel === NotificationChannel.email) {
        const delivered = await this.deliverEmail(destination, text, vars);
        return this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            status: delivered.mode === 'mock' ? 'sent_mock' : 'sent',
            payload: {
              ...vars,
              renderedText: text,
              destination,
              providerMode: delivered.mode,
              providerRaw: delivered.raw ?? null,
            } as Prisma.InputJsonValue,
          },
        });
      }

      const delivered = await this.deliverSms(destination, text);
      return this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: delivered.mode === 'mock' ? 'sent_mock' : 'sent',
          payload: {
            ...vars,
            renderedText: text,
            destination,
            providerMode: delivered.mode,
            providerRaw: delivered.raw ?? null,
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

  /** Email/SMS invoice for an existing order */
  async sendOrderInvoice(user: AuthUser, dto: SendInvoiceDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: {
        customer: {
          select: { id: true, fullName: true, phone: true, email: true },
        },
        location: { select: { name: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.customerId || !order.customer) {
      throw new BadRequestException('Order has no customer to invoice');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const channels = dto.channels?.length
      ? dto.channels
      : (['email', 'sms'] as Array<'email' | 'sms' | 'whatsapp'>);
    const total =
      Number(order.subtotal) +
      Number(order.taxTotal) -
      Number(order.discountTotal);
    const results = [];
    for (const channel of channels) {
      try {
        const row = await this.send(user, {
          customerId: order.customerId,
          channel: channel as NotificationChannel,
          templateKey: 'sale_invoice',
          payload: {
            orderNumber: order.orderNumber,
            storeName: tenant?.name ?? order.location.name,
            subtotal: Number(order.subtotal).toFixed(2),
            taxTotal: Number(order.taxTotal).toFixed(2),
            total: total.toFixed(2),
            balanceDue: Number(order.balanceDue).toFixed(2),
            customerName: order.customer.fullName,
          },
        });
        results.push({ channel, status: row.status, id: row.id });
      } catch (e) {
        results.push({
          channel,
          status: 'failed',
          error: e instanceof Error ? e.message : 'failed',
        });
      }
    }
    return { orderId: order.id, orderNumber: order.orderNumber, results };
  }

  async listBirthdayUpcoming(user: AuthUser, days = 30) {
    const window = Math.min(Math.max(days, 1), 90);
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { timezone: true, name: true },
    });
    const tz = tenant?.timezone || 'Asia/Kolkata';
    const todayParts = this.ymdParts(new Date(), tz);
    const customers = await this.prisma.customer.findMany({
      where: {
        tenantId: user.tenantId,
        deletedAt: null,
        dateOfBirth: { not: null },
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        dateOfBirth: true,
        marketingOptIn: true,
      },
      take: 2000,
    });

    const items = customers
      .map((c) => {
        const dob = c.dateOfBirth!;
        const month = dob.getUTCMonth() + 1;
        const day = dob.getUTCDate();
        const daysUntil = this.daysUntilNextBirthday(
          todayParts.month,
          todayParts.day,
          todayParts.year,
          month,
          day,
        );
        if (daysUntil > window) return null;
        return {
          id: c.id,
          fullName: c.fullName,
          phone: c.phone,
          email: c.email,
          dateOfBirth: dob.toISOString().slice(0, 10),
          month,
          day,
          daysUntil,
          marketingOptIn: c.marketingOptIn,
          canSend: c.marketingOptIn === true,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => a.daysUntil - b.daysUntil);

    return {
      timezone: tz,
      storeName: tenant?.name ?? null,
      windowDays: window,
      count: items.length,
      items,
    };
  }

  async sendBirthdayToday(
    user: AuthUser,
    channels: Array<'email' | 'sms' | 'whatsapp'> = ['sms', 'whatsapp'],
  ) {
    const today = (await this.listBirthdayUpcoming(user, 1)).items.filter(
      (i) => i.daysUntil === 0 && i.canSend,
    );
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const results = [];
    for (const c of today) {
      for (const channel of channels) {
        if (channel === 'email' && !c.email) {
          results.push({
            customerId: c.id,
            channel,
            status: 'skipped',
            reason: 'no_email',
          });
          continue;
        }
        try {
          const row = await this.send(user, {
            customerId: c.id,
            channel: channel as NotificationChannel,
            templateKey: 'birthday_wish',
            payload: {
              customerName: c.fullName,
              storeName: tenant?.name ?? 'our store',
            },
          });
          results.push({
            customerId: c.id,
            channel,
            status: row.status,
          });
        } catch (e) {
          results.push({
            customerId: c.id,
            channel,
            status: 'failed',
            error: e instanceof Error ? e.message : 'failed',
          });
        }
      }
    }
    return {
      sentFor: today.length,
      results,
      note: 'Only marketingOptIn customers with birthday today are included',
    };
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

  private async deliverEmail(
    to: string,
    text: string,
    vars: Record<string, unknown>,
  ): Promise<{ mode: 'mock' | 'webhook' | 'smtp'; raw?: unknown }> {
    const subject =
      (typeof vars.subject === 'string' && vars.subject.trim()
        ? vars.subject.trim()
        : vars.orderNumber
          ? `Invoice ${String(vars.orderNumber)}`
          : 'Message from Universal POS');
    if (this.mail.isConfigured()) {
      await this.mail.send({ to, subject, text });
      return { mode: 'smtp' };
    }
    const url = this.config.get<string>('EMAIL_WEBHOOK_URL')?.trim();
    if (!url) {
      this.log.log(`[email] mock send → ${to}: ${text.slice(0, 120)}`);
      return { mode: 'mock' };
    }
    const from = this.mail.fromAddress();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from, subject, text }),
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Email webhook failed (${res.status})`,
      );
    }
    const raw = await res.json().catch(() => null);
    return { mode: 'webhook', raw };
  }

  private async deliverSms(
    to: string,
    text: string,
  ): Promise<{ mode: 'mock' | 'webhook'; raw?: unknown }> {
    const url = this.config.get<string>('SMS_WEBHOOK_URL')?.trim();
    if (!url) {
      this.log.log(`[sms] mock send → ${to}: ${text.slice(0, 120)}`);
      return { mode: 'mock' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) {
      throw new BadRequestException(`SMS webhook failed (${res.status})`);
    }
    const raw = await res.json().catch(() => null);
    return { mode: 'webhook', raw };
  }

  private ymdParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? '0');
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  private daysUntilNextBirthday(
    nowMonth: number,
    nowDay: number,
    nowYear: number,
    bMonth: number,
    bDay: number,
  ) {
    const start = Date.UTC(nowYear, nowMonth - 1, nowDay);
    let targetYear = nowYear;
    let target = Date.UTC(targetYear, bMonth - 1, bDay);
    if (target < start) {
      targetYear += 1;
      target = Date.UTC(targetYear, bMonth - 1, bDay);
    }
    return Math.round((target - start) / (24 * 3600 * 1000));
  }
}
