import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { decryptField, encryptField } from './field-crypto';
import { ipMatchesAllowlist } from './client-ip';
import {
  generateBackupCodes,
  generateTotpSecret,
  totpOtpauthUrl,
  verifyTotp,
} from './totp';
import {
  mergeSecuritySettings,
  parseSecuritySettings,
} from './security-settings';
import type { RestoreBackupDto, UpdateSecuritySettingsDto } from './dto/security.dto';

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_blocked_locked': 'Sign-in blocked (locked)',
  'auth.logout': 'Signed out',
  'auth.2fa_enabled': 'Enabled two-factor authentication',
  'auth.2fa_disabled': 'Disabled two-factor authentication',
  'auth.2fa_verified': 'Completed 2FA sign-in',
  'security.settings_updated': 'Updated security settings',
  'security.backup_exported': 'Exported shop backup',
  'security.backup_restored': 'Restored shop backup',
  'tenant.settings_updated': 'Updated shop settings',
};

@Injectable()
export class SecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  cryptoKey() {
    return (
      this.config.get<string>('SECURITY_DATA_KEY')?.trim() ||
      this.config.get<string>('JWT_ACCESS_SECRET') ||
      'dev-only-change-me'
    );
  }

  encryptionStatus() {
    const dedicated = Boolean(this.config.get<string>('SECURITY_DATA_KEY')?.trim());
    return {
      passwordsHashed: true as const,
      totpSecretsEncrypted: true as const,
      backupEncryptionAvailable: true as const,
      dedicatedDataKey: dedicated,
      note: dedicated
        ? 'Dedicated SECURITY_DATA_KEY is set for field/backup encryption.'
        : 'Using JWT secret to derive encryption key — set SECURITY_DATA_KEY in production.',
    };
  }

  async getSettings(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const parsed = parseSecuritySettings(tenant?.settings);
    return {
      ...parsed,
      encryption: this.encryptionStatus(),
    };
  }

  async updateSettings(user: AuthUser, dto: UpdateSecuritySettingsDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    const next = mergeSecuritySettings(tenant.settings, {
      ipAllowlist: dto.ipAllowlist,
      idleTimeoutMinutes: dto.idleTimeoutMinutes,
      encryptBackups: dto.encryptBackups,
    });
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: next as Prisma.InputJsonValue },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant',
        entityId: user.tenantId,
        action: 'security.settings_updated',
        beforeAfter: { security: next.security } as Prisma.InputJsonValue,
      },
    });
    return this.getSettings(user);
  }

  async assertTenantIp(tenantId: string, ip: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const { ipAllowlist } = parseSecuritySettings(tenant?.settings);
    if (!ipMatchesAllowlist(ip, ipAllowlist)) {
      throw new ForbiddenException(
        'This IP is not allowed for this shop. Ask an admin to update IP restrictions.',
      );
    }
  }

  async listAudit(user: AuthUser, query: {
    action?: string;
    entityType?: string;
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const take = query.limit ?? 80;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const q = query.q?.trim();

    const where: Prisma.AuditLogWhereInput = {
      tenantId: user.tenantId,
      ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
              ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { action: { contains: q, mode: 'insensitive' } },
              { entityType: { contains: q, mode: 'insensitive' } },
              { ip: { contains: q, mode: 'insensitive' } },
              { actor: { fullName: { contains: q, mode: 'insensitive' } } },
              { actor: { email: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { id: true, fullName: true, email: true } },
      },
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        label: ACTION_LABELS[r.action] ?? r.action.replace(/[._]/g, ' '),
        entityType: r.entityType,
        entityId: r.entityId,
        ip: r.ip,
        device: r.device,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor
          ? { id: r.actor.id, name: r.actor.fullName, email: r.actor.email }
          : null,
        beforeAfter: r.beforeAfter,
      })),
    };
  }

  async my2fa(user: AuthUser) {
    const row = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      select: { totpEnabled: true, totpEnabledAt: true },
    });
    return {
      enabled: Boolean(row?.totpEnabled),
      enabledAt: row?.totpEnabledAt?.toISOString() ?? null,
    };
  }

  async setup2fa(user: AuthUser) {
    const secret = generateTotpSecret();
    const enc = encryptField(secret, this.cryptoKey());
    await this.prisma.user.update({
      where: { id: user.userId },
      data: { totpSecretEnc: enc, totpEnabled: false },
    });
    const otpauthUrl = totpOtpauthUrl({
      secret,
      email: user.email,
      issuer: 'Universal POS',
    });
    return {
      secret,
      otpauthUrl,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUrl)}`,
    };
  }

  async enable2fa(user: AuthUser, code: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      select: { totpSecretEnc: true },
    });
    if (!row?.totpSecretEnc) {
      throw new BadRequestException('Start 2FA setup first');
    }
    const secret = decryptField(row.totpSecretEnc, this.cryptoKey());
    if (!verifyTotp(secret, code)) {
      throw new UnauthorizedException('Invalid authenticator code');
    }
    const backup = generateBackupCodes(8);
    const hashes = await Promise.all(backup.map((c) => bcrypt.hash(c, 10)));
    await this.prisma.user.update({
      where: { id: user.userId },
      data: {
        totpEnabled: true,
        totpEnabledAt: new Date(),
        totpBackupHashes: hashes as Prisma.InputJsonValue,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'user',
        entityId: user.userId,
        action: 'auth.2fa_enabled',
      },
    });
    return { enabled: true, backupCodes: backup };
  }

  async disable2fa(user: AuthUser, password: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      select: { passwordHash: true },
    });
    if (!row) throw new NotFoundException('User not found');
    const ok = await bcrypt.compare(password, row.passwordHash);
    if (!ok) throw new UnauthorizedException('Password incorrect');
    await this.prisma.user.update({
      where: { id: user.userId },
      data: {
        totpEnabled: false,
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpBackupHashes: [] as Prisma.InputJsonValue,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'user',
        entityId: user.userId,
        action: 'auth.2fa_disabled',
      },
    });
    return { enabled: false };
  }

  async consumeTotpOrBackup(userId: string, tenantId: string, code: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { totpSecretEnc: true, totpEnabled: true, totpBackupHashes: true },
    });
    if (!row?.totpEnabled || !row.totpSecretEnc) {
      throw new UnauthorizedException('2FA is not enabled');
    }
    const secret = decryptField(row.totpSecretEnc, this.cryptoKey());
    if (verifyTotp(secret, code)) return true;

    const hashes = Array.isArray(row.totpBackupHashes)
      ? (row.totpBackupHashes as unknown[]).filter(
          (h): h is string => typeof h === 'string',
        )
      : [];
    const compact = code.replace(/\s/g, '');
    for (let i = 0; i < hashes.length; i++) {
      if (await bcrypt.compare(compact, hashes[i]!)) {
        const next = hashes.filter((_, idx) => idx !== i);
        await this.prisma.user.update({
          where: { id: userId },
          data: { totpBackupHashes: next as Prisma.InputJsonValue },
        });
        return true;
      }
    }
    throw new UnauthorizedException('Invalid 2FA code');
  }

  async exportBackup(user: AuthUser) {
    const settings = await this.getSettings(user);
    const [
      tenant,
      products,
      categories,
      customers,
      stockLevels,
      locations,
      coupons,
    ] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          taxMode: true,
          currencyCode: true,
          locale: true,
          timezone: true,
          branding: true,
          settings: true,
        },
      }),
      this.prisma.product.findMany({
        where: { tenantId: user.tenantId },
        take: 4000,
        select: {
          id: true,
          name: true,
          skuCode: true,
          barcode: true,
          categoryId: true,
          kind: true,
          status: true,
          basePrice: true,
          mrp: true,
          taxCode: true,
          unitOfMeasure: true,
          canSell: true,
          availableInPos: true,
        },
      }),
      this.prisma.category.findMany({
        where: { tenantId: user.tenantId },
        take: 1000,
        select: { id: true, name: true, parentId: true },
      }),
      this.prisma.customer.findMany({
        where: { tenantId: user.tenantId, deletedAt: null },
        take: 5000,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          creditLimit: true,
          storeCreditBalance: true,
          loyaltyPoints: true,
        },
      }),
      this.prisma.stockLevel.findMany({
        where: { tenantId: user.tenantId },
        take: 8000,
        select: {
          productId: true,
          locationId: true,
          sku: true,
          qtyOnHand: true,
          sellPrice: true,
          reorderPoint: true,
        },
      }),
      this.prisma.location.findMany({
        where: { tenantId: user.tenantId },
        select: { id: true, name: true, code: true, type: true, isActive: true },
      }),
      this.prisma.coupon.findMany({
        where: { tenantId: user.tenantId },
        take: 500,
        select: {
          code: true,
          description: true,
          discountType: true,
          discountValue: true,
          isActive: true,
        },
      }),
    ]);

    const payload = {
      tenant,
      products: products.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        mrp: p.mrp != null ? Number(p.mrp) : null,
      })),
      categories,
      customers: customers.map((c) => ({
        ...c,
        creditLimit: c.creditLimit != null ? Number(c.creditLimit) : null,
        storeCreditBalance: Number(c.storeCreditBalance),
      })),
      stockLevels: stockLevels.map((s) => ({
        ...s,
        qtyOnHand: Number(s.qtyOnHand),
        sellPrice: Number(s.sellPrice),
        reorderPoint: s.reorderPoint != null ? Number(s.reorderPoint) : null,
      })),
      locations,
      coupons: coupons.map((c) => ({
        ...c,
        discountValue: Number(c.discountValue),
      })),
    };

    const body: Record<string, unknown> = {
      format: 'upos-backup-v1',
      exportedAt: new Date().toISOString(),
      tenantId: user.tenantId,
      encrypted: settings.encryptBackups,
    };

    if (settings.encryptBackups) {
      body.ciphertext = encryptField(JSON.stringify(payload), this.cryptoKey());
    } else {
      body.payload = payload;
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant',
        entityId: user.tenantId,
        action: 'security.backup_exported',
        beforeAfter: {
          encrypted: settings.encryptBackups,
          counts: {
            products: products.length,
            customers: customers.length,
            stockLevels: stockLevels.length,
          },
        } as Prisma.InputJsonValue,
      },
    });

    return body;
  }

  async restoreBackup(user: AuthUser, dto: RestoreBackupDto) {
    const file = dto.backup;
    if (file.format !== 'upos-backup-v1') {
      throw new BadRequestException('Not a Universal POS backup file');
    }
    let payload: Record<string, unknown>;
    if (file.encrypted || file.ciphertext) {
      if (typeof file.ciphertext !== 'string') {
        throw new BadRequestException('Encrypted backup is missing ciphertext');
      }
      try {
        payload = JSON.parse(decryptField(file.ciphertext, this.cryptoKey())) as Record<
          string,
          unknown
        >;
      } catch {
        throw new BadRequestException('Could not decrypt backup — wrong key or corrupt file');
      }
    } else if (file.payload && typeof file.payload === 'object') {
      payload = file.payload as Record<string, unknown>;
    } else {
      throw new BadRequestException('Backup has no payload');
    }

    const products = Array.isArray(payload.products) ? payload.products : [];
    const customers = Array.isArray(payload.customers) ? payload.customers : [];
    const categories = Array.isArray(payload.categories) ? payload.categories : [];

    let productsUpserted = 0;
    let customersUpserted = 0;
    let categoriesUpserted = 0;

    for (const raw of categories) {
      const c = raw as { name?: string; parentId?: string | null };
      if (!c.name?.trim()) continue;
      await this.prisma.category.upsert({
        where: { tenantId_name: { tenantId: user.tenantId, name: c.name.trim() } },
        create: { tenantId: user.tenantId, name: c.name.trim() },
        update: {},
      });
      categoriesUpserted += 1;
    }

    const catRows = await this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true },
    });
    const catByName = new Map(catRows.map((c) => [c.name, c.id]));

    for (const raw of products) {
      const p = raw as {
        name?: string;
        skuCode?: string;
        barcode?: string | null;
        kind?: string;
        status?: string;
        basePrice?: number;
        categoryId?: string | null;
      };
      const sku = p.skuCode?.trim().slice(0, 18);
      const name = p.name?.trim();
      if (!sku || !name) continue;
      const existing = await this.prisma.product.findFirst({
        where: { tenantId: user.tenantId, skuCode: sku },
        select: { id: true },
      });
      const data = {
        name,
        barcode: p.barcode ?? null,
        basePrice: p.basePrice ?? 0,
        availableInPos: true,
        canSell: true,
      };
      if (existing) {
        await this.prisma.product.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.product.create({
          data: {
            tenantId: user.tenantId,
            skuCode: sku,
            ...data,
          },
        });
      }
      productsUpserted += 1;
      void catByName;
    }

    for (const raw of customers) {
      const c = raw as {
        fullName?: string;
        phone?: string;
        email?: string | null;
      };
      const phone = c.phone?.trim();
      const fullName = c.fullName?.trim();
      if (!phone || !fullName) continue;
      await this.prisma.customer.upsert({
        where: { tenantId_phone: { tenantId: user.tenantId, phone } },
        create: {
          tenantId: user.tenantId,
          fullName,
          phone,
          email: c.email ?? null,
        },
        update: { fullName, email: c.email ?? undefined },
      });
      customersUpserted += 1;
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant',
        entityId: user.tenantId,
        action: 'security.backup_restored',
        beforeAfter: {
          productsUpserted,
          customersUpserted,
          categoriesUpserted,
        } as Prisma.InputJsonValue,
      },
    });

    return { ok: true, productsUpserted, customersUpserted, categoriesUpserted };
  }
}
