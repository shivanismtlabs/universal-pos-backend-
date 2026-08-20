import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { paginate, pageMeta } from '../../common/dto/pagination.dto';
import {
  NOTIFICATION_TYPES,
  notificationTypeMeta,
  type NotificationTypeCode,
} from './notification-types';
import { Role } from '../../common/roles';
import { FirebasePushService } from './firebase-push.service';

export type EmitNotificationInput = {
  tenantId: string;
  type: NotificationTypeCode | string;
  title: string;
  body: string;
  /** Branch scope — ACL + filter */
  locationId?: string | null;
  severity?: 'info' | 'low' | 'critical';
  href?: string | null;
  /** Suppress duplicates while open */
  dedupeKey?: string | null;
  groupKey?: string | null;
  payload?: Record<string, unknown>;
  /** Override recipient user ids (skips role routing) */
  recipientUserIds?: string[];
  /** Role codes if not using recipientUserIds */
  recipientRoles?: string[];
};

type TenantNotifSettings = {
  types?: Record<
    string,
    {
      enabled?: boolean;
      recipientRoles?: string[];
      digestMinutes?: number;
      reAlertHours?: number;
    }
  >;
};

@Injectable()
export class NotificationEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebasePushService,
  ) {}

  catalog() {
    return NOTIFICATION_TYPES.map((t) => ({ ...t }));
  }

  async getTenantTypeConfig(tenantId: string, type: string) {
    const meta = notificationTypeMeta(type);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const block =
      root.notifications && typeof root.notifications === 'object'
        ? (root.notifications as TenantNotifSettings)
        : {};
    const cfg = block.types?.[type] ?? {};
    return {
      enabled: cfg.enabled ?? meta?.defaultEnabled ?? false,
      recipientRoles:
        cfg.recipientRoles ?? meta?.defaultRoles ?? ([Role.admin] as string[]),
      digestMinutes: cfg.digestMinutes ?? 15,
      reAlertHours: cfg.reAlertHours ?? 24,
    };
  }

  async getTenantSettings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const block =
      root.notifications && typeof root.notifications === 'object'
        ? (root.notifications as TenantNotifSettings)
        : {};
    return {
      types: NOTIFICATION_TYPES.map((t) => {
        const cfg = block.types?.[t.code] ?? {};
        return {
          code: t.code,
          label: t.label,
          description: t.description,
          urgent: t.urgent,
          enabled: cfg.enabled ?? t.defaultEnabled,
          recipientRoles: cfg.recipientRoles ?? [...t.defaultRoles],
          digestMinutes: cfg.digestMinutes ?? 15,
          reAlertHours: cfg.reAlertHours ?? 24,
        };
      }),
    };
  }

  async updateTenantSettings(
    tenantId: string,
    types: Array<{
      code: string;
      enabled?: boolean;
      recipientRoles?: string[];
      digestMinutes?: number;
      reAlertHours?: number;
    }>,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const prev =
      root.notifications && typeof root.notifications === 'object'
        ? { ...(root.notifications as TenantNotifSettings) }
        : {};
    const typeMap = { ...(prev.types ?? {}) };
    for (const t of types) {
      const cur = typeMap[t.code] ?? {};
      typeMap[t.code] = {
        ...cur,
        ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
        ...(t.recipientRoles !== undefined
          ? { recipientRoles: t.recipientRoles }
          : {}),
        ...(t.digestMinutes !== undefined
          ? { digestMinutes: t.digestMinutes }
          : {}),
        ...(t.reAlertHours !== undefined
          ? { reAlertHours: t.reAlertHours }
          : {}),
      };
    }
    root.notifications = { ...prev, types: typeMap };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });
    return this.getTenantSettings(tenantId);
  }

  /** Resolve staff who should receive this type at a branch */
  async resolveRecipients(opts: {
    tenantId: string;
    locationId?: string | null;
    roles: string[];
  }): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: opts.tenantId,
        isActive: true,
        userRoles: {
          some: {
            role: {
              tenantId: opts.tenantId,
              code: { in: opts.roles },
            },
          },
        },
      },
      select: {
        id: true,
        primaryLocationId: true,
        userRoles: {
          where: { role: { tenantId: opts.tenantId } },
          select: {
            locationId: true,
            role: { select: { code: true } },
          },
        },
      },
    });

    const ids = new Set<string>();
    for (const u of users) {
      const codes = u.userRoles.map((r) => r.role.code);
      const isAdmin = codes.includes(Role.admin);
      if (isAdmin) {
        ids.add(u.id);
        continue;
      }
      if (!opts.locationId) {
        ids.add(u.id);
        continue;
      }
      // Branch scoped: primary location match OR role grant on location OR no location on role (HQ manager)
      const locOk =
        u.primaryLocationId === opts.locationId ||
        u.userRoles.some(
          (r) =>
            r.locationId === opts.locationId ||
            r.locationId == null,
        );
      if (locOk) ids.add(u.id);
    }
    return [...ids];
  }

  /**
   * Core emit — checks tenant enable, prefs, dedupe; writes in-app (+ log stub for email/push later).
   */
  async emit(input: EmitNotificationInput) {
    const cfg = await this.getTenantTypeConfig(input.tenantId, input.type);
    if (!cfg.enabled) {
      return { skipped: true as const, reason: 'type_disabled' };
    }

    const roles = input.recipientRoles?.length
      ? input.recipientRoles
      : cfg.recipientRoles;
    const recipients =
      input.recipientUserIds?.length
        ? input.recipientUserIds
        : await this.resolveRecipients({
            tenantId: input.tenantId,
            locationId: input.locationId,
            roles,
          });

    if (!recipients.length) {
      return { skipped: true as const, reason: 'no_recipients', created: 0 };
    }

    const severity = input.severity ?? 'info';
    let created = 0;
    const createdIds: string[] = [];

    for (const userId of recipients) {
      const pref = await this.prisma.userNotificationPreference.findUnique({
        where: {
          tenantId_userId_type: {
            tenantId: input.tenantId,
            userId,
            type: input.type,
          },
        },
      });
      if (pref && !pref.enabled) continue;

      // Defaults when no preference row: in-app + push (FCM) on
      const wantInApp = pref ? pref.inApp : true;
      const wantPush = pref ? pref.push : true;
      if (!wantInApp && !wantPush) continue;

      let notificationId: string | null = null;

      if (input.dedupeKey) {
        const existing = await this.prisma.appNotification.findFirst({
          where: {
            tenantId: input.tenantId,
            userId,
            dedupeKey: input.dedupeKey,
            resolvedAt: null,
            status: { in: ['unread', 'read'] },
          },
        });
        if (existing) {
          // Escalate severity if upgraded
          if (
            severity === 'critical' &&
            existing.severity !== 'critical'
          ) {
            await this.prisma.appNotification.update({
              where: { id: existing.id },
              data: {
                severity: 'critical',
                title: input.title,
                body: input.body,
                href: input.href ?? existing.href,
                payload: input.payload as Prisma.InputJsonValue,
                status: 'unread',
                readAt: null,
              },
            });
            createdIds.push(existing.id);
            notificationId = existing.id;
            if (wantPush) {
              void this.firebase.sendToUser({
                tenantId: input.tenantId,
                userId,
                title: input.title,
                body: input.body,
                href: input.href,
                data: {
                  type: input.type,
                  notificationId: existing.id,
                  severity: 'critical',
                },
              });
            }
          }
          continue;
        }

        // Re-alert window: skip if resolved recently for same key? only for open tracked above
        const hours = cfg.reAlertHours;
        if (hours > 0) {
          const since = new Date(Date.now() - hours * 3600_000);
          const recent = await this.prisma.appNotification.findFirst({
            where: {
              tenantId: input.tenantId,
              userId,
              dedupeKey: input.dedupeKey,
              createdAt: { gte: since },
            },
          });
          if (recent && recent.resolvedAt) continue;
        }
      }

      try {
        if (wantInApp) {
          const row = await this.prisma.appNotification.create({
            data: {
              tenantId: input.tenantId,
              userId,
              locationId: input.locationId ?? null,
              type: input.type,
              severity,
              title: input.title,
              body: input.body,
              href: input.href ?? null,
              dedupeKey: input.dedupeKey ?? null,
              groupKey: input.groupKey ?? null,
              payload: (input.payload ?? {}) as Prisma.InputJsonValue,
            },
          });
          created += 1;
          createdIds.push(row.id);
          notificationId = row.id;

          await this.prisma.notificationLog.create({
            data: {
              tenantId: input.tenantId,
              channel: 'in_app',
              templateKey: input.type,
              status: 'delivered',
              payload: {
                notificationId: row.id,
                userId,
                locationId: input.locationId,
              } as Prisma.InputJsonValue,
            },
          });
        }

        if (wantPush) {
          const pushRes = await this.firebase.sendToUser({
            tenantId: input.tenantId,
            userId,
            title: input.title,
            body: input.body,
            href: input.href,
            data: {
              type: input.type,
              notificationId: notificationId ?? '',
              severity,
            },
          });
          await this.prisma.notificationLog.create({
            data: {
              tenantId: input.tenantId,
              channel: 'push',
              templateKey: input.type,
              status:
                pushRes.skipped || !pushRes.sent ? 'skipped' : 'delivered',
              payload: {
                userId,
                ...pushRes,
                notificationId,
              } as Prisma.InputJsonValue,
            },
          });
        }
      } catch (e) {
        // Unique race on dedupe — ignore
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          continue;
        }
        throw e;
      }
    }

    return { skipped: false as const, created, ids: createdIds };
  }

  /** Mark matching open alerts resolved (e.g. stock replenished) */
  async resolveByDedupe(opts: {
    tenantId: string;
    dedupeKey: string;
  }) {
    const res = await this.prisma.appNotification.updateMany({
      where: {
        tenantId: opts.tenantId,
        dedupeKey: opts.dedupeKey,
        resolvedAt: null,
      },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
      },
    });
    return { resolved: res.count };
  }

  async listForUser(
    user: { userId: string; tenantId: string },
    opts: {
      status?: string;
      type?: string;
      locationId?: string;
      limit?: number;
      page?: number;
    } = {},
  ) {
    const { page, limit, skip } = paginate(opts.page, opts.limit ?? 25);
    const where: Prisma.AppNotificationWhereInput = {
      tenantId: user.tenantId,
      userId: user.userId,
      ...(opts.status ? { status: opts.status } : { status: { not: 'archived' } }),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.locationId ? { locationId: opts.locationId } : {}),
    };
    const [items, unread, total] = await Promise.all([
      this.prisma.appNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          location: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.appNotification.count({
        where: {
          tenantId: user.tenantId,
          userId: user.userId,
          status: 'unread',
          resolvedAt: null,
        },
      }),
      this.prisma.appNotification.count({ where }),
    ]);
    return {
      unreadCount: unread,
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        severity: n.severity,
        status: n.status,
        title: n.title,
        body: n.body,
        href: n.href,
        locationId: n.locationId,
        location: n.location,
        payload: n.payload,
        createdAt: n.createdAt,
        readAt: n.readAt,
        resolvedAt: n.resolvedAt,
      })),
      meta: pageMeta(total, page, limit),
    };
  }

  async markRead(user: { userId: string; tenantId: string }, id: string) {
    const row = await this.prisma.appNotification.findFirst({
      where: { id, tenantId: user.tenantId, userId: user.userId },
    });
    if (!row) return null;
    if (row.status === 'unread') {
      return this.prisma.appNotification.update({
        where: { id },
        data: { status: 'read', readAt: new Date() },
      });
    }
    return row;
  }

  async markAllRead(user: { userId: string; tenantId: string }) {
    const res = await this.prisma.appNotification.updateMany({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        status: 'unread',
      },
      data: { status: 'read', readAt: new Date() },
    });
    return { updated: res.count };
  }

  async getUserPrefs(user: { userId: string; tenantId: string }) {
    const rows = await this.prisma.userNotificationPreference.findMany({
      where: { tenantId: user.tenantId, userId: user.userId },
    });
    const map = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_TYPES.map((t) => {
      const r = map.get(t.code);
      return {
        type: t.code,
        label: t.label,
        description: t.description,
        enabled: r?.enabled ?? true,
        inApp: r?.inApp ?? true,
        email: r?.email ?? false,
        // Default push on (FCM) — matches emit() when no preference row
        push: r?.push ?? true,
        sms: r?.sms ?? false,
      };
    });
  }

  async upsertUserPrefs(
    user: { userId: string; tenantId: string },
    prefs: Array<{
      type: string;
      enabled?: boolean;
      inApp?: boolean;
      email?: boolean;
      push?: boolean;
      sms?: boolean;
    }>,
  ) {
    for (const p of prefs) {
      await this.prisma.userNotificationPreference.upsert({
        where: {
          tenantId_userId_type: {
            tenantId: user.tenantId,
            userId: user.userId,
            type: p.type,
          },
        },
        create: {
          tenantId: user.tenantId,
          userId: user.userId,
          type: p.type,
          enabled: p.enabled ?? true,
          inApp: p.inApp ?? true,
          email: p.email ?? false,
          push: p.push ?? true,
          sms: p.sms ?? false,
        },
        update: {
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
          ...(p.inApp !== undefined ? { inApp: p.inApp } : {}),
          ...(p.email !== undefined ? { email: p.email } : {}),
          ...(p.push !== undefined ? { push: p.push } : {}),
          ...(p.sms !== undefined ? { sms: p.sms } : {}),
        },
      });
    }
    return this.getUserPrefs(user);
  }
}
