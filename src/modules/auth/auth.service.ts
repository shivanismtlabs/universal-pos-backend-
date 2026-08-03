import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../database/database.module';
import type {
  LoginDto,
  RefreshTokenDto,
  RegisterTenantDto,
} from './dto/auth.dto';
import { RESERVED_TENANT_SLUGS } from './password.policy';
import type { AuthUser, JwtPayload } from './types';

const DEFAULT_ROLES = [
  'admin',
  'manager',
  'cashier',
  'fitter',
  'inventory',
] as const;

const DEFAULT_PERMISSIONS = [
  'refund',
  'discount_override',
  'price_change',
] as const;

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

/** Valid bcrypt hash used only to keep login timing consistent */
const DUMMY_PASSWORD_HASH =
  '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async registerTenant(dto: RegisterTenantDto) {
    const slug = dto.tenantSlug.trim().toLowerCase();
    const email = dto.adminEmail.trim().toLowerCase();
    const fullName = dto.adminFullName.trim();
    const tenantName = dto.tenantName.trim();
    const storeName = dto.storeName.trim();

    if (RESERVED_TENANT_SLUGS.has(slug)) {
      throw new BadRequestException('This tenant slug is reserved');
    }

    if (dto.adminPassword.toLowerCase().includes(slug)) {
      throw new BadRequestException('Password must not contain tenant slug');
    }
    if (dto.adminPassword.toLowerCase().includes(email.split('@')[0])) {
      throw new BadRequestException(
        'Password must not contain email local-part',
      );
    }

    const existing = await this.prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      throw new ConflictException('Tenant slug already taken');
    }

    const passwordHash = await bcrypt.hash(dto.adminPassword, BCRYPT_ROUNDS);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug,
          gstin: dto.gstin?.toUpperCase(),
          status: 'active',
        },
      });

      const store = await tx.store.create({
        data: {
          tenantId: tenant.id,
          name: storeName,
          code: 'MAIN',
          isActive: true,
        },
      });

      for (const code of DEFAULT_PERMISSIONS) {
        await tx.permission.upsert({
          where: { code },
          create: { code },
          update: {},
        });
      }

      const roleRecords = [];
      for (const code of DEFAULT_ROLES) {
        const role = await tx.role.create({
          data: { tenantId: tenant.id, code },
        });
        roleRecords.push(role);
      }

      const adminRole = roleRecords.find((r) => r.code === 'admin')!;
      const allPermissions = await tx.permission.findMany({
        where: { code: { in: [...DEFAULT_PERMISSIONS] } },
      });

      for (const permission of allPermissions) {
        await tx.rolePermission.create({
          data: {
            roleId: adminRole.id,
            permissionId: permission.id,
          },
        });
      }

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          primaryStoreId: store.id,
          email,
          phone: dto.adminPhone,
          passwordHash,
          fullName,
          isActive: true,
          passwordChangedAt: now,
          failedLoginAttempts: 0,
        },
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: adminRole.id,
          storeId: store.id,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: user.id,
          entityType: 'tenant',
          entityId: tenant.id,
          action: 'tenant.registered',
          beforeAfter: { slug, storeId: store.id },
        },
      });

      return { tenant, store, user, roles: ['admin'] };
    });

    const tokens = await this.issueTokens({
      userId: result.user.id,
      tenantId: result.tenant.id,
      email: result.user.email,
      fullName: result.user.fullName,
      storeId: result.store.id,
      roles: result.roles,
    });

    return {
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
      store: {
        id: result.store.id,
        name: result.store.name,
        code: result.store.code,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        fullName: result.user.fullName,
        roles: result.roles,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const slug = dto.tenantSlug.trim().toLowerCase();
    const email = dto.email.trim().toLowerCase();
    const password = dto.password;

    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });

    const user =
      tenant && tenant.status === 'active'
        ? await this.prisma.user.findFirst({
            where: { tenantId: tenant.id, email },
            include: { userRoles: { include: { role: true } } },
          })
        : null;

    // Always burn bcrypt time (user enumeration / timing)
    const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordOk = await bcrypt.compare(password, hash);

    if (!tenant || tenant.status !== 'active' || !user || !user.isActive) {
      await this.safeAuditFailedLogin(tenant?.id, email, 'user_or_tenant');
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'auth.login_blocked_locked',
        },
      });
      throw new UnauthorizedException(
        'Account temporarily locked. Try again later.',
      );
    }

    if (!passwordOk) {
      const attempts = user.failedLoginAttempts + 1;
      const lockedUntil =
        attempts >= MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : null;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockedUntil ?? undefined,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'auth.login_failed',
          beforeAfter: { attempts, locked: Boolean(lockedUntil) },
        },
      });

      if (lockedUntil) {
        throw new UnauthorizedException(
          'Too many failed attempts. Account locked for 15 minutes.',
        );
      }

      throw new UnauthorizedException('Invalid credentials');
    }

    const roles = user.userRoles.map((ur) => ur.role.code);
    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      storeId: user.primaryStoreId,
      roles,
    };

    const tokens = await this.issueTokens(authUser);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.id,
        entityType: 'user',
        entityId: user.id,
        action: 'auth.login',
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roles,
        storeId: user.primaryStoreId,
        tenantId: user.tenantId,
      },
      ...tokens,
    };
  }

  async refresh(dto: RefreshTokenDto) {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(dto.refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        tenantId: payload.tenantId,
        isActive: true,
        tenant: { status: 'active' },
      },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user?.refreshTokenHash || !user.refreshTokenExpiresAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (user.refreshTokenExpiresAt < new Date()) {
      await this.clearRefreshToken(user.id);
      throw new UnauthorizedException('Refresh token expired');
    }

    const incomingHash = this.hashToken(dto.refreshToken);
    if (incomingHash !== user.refreshTokenHash) {
      // Possible reuse / theft → revoke
      await this.clearRefreshToken(user.id);
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'auth.refresh_reuse_detected',
        },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      storeId: user.primaryStoreId,
      roles: user.userRoles.map((ur) => ur.role.code),
    };

    // Rotate refresh token
    return this.issueTokens(authUser);
  }

  async logout(user: AuthUser) {
    await this.clearRefreshToken(user.userId);
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'user',
        entityId: user.userId,
        action: 'auth.logout',
      },
    });
    return null;
  }

  async me(user: AuthUser) {
    const dbUser = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId, isActive: true },
      include: {
        tenant: { select: { id: true, name: true, slug: true, status: true } },
        primaryStore: {
          select: { id: true, name: true, code: true },
        },
        userRoles: { include: { role: true } },
      },
    });

    if (!dbUser || dbUser.tenant.status !== 'active') {
      throw new UnauthorizedException();
    }

    return {
      id: dbUser.id,
      email: dbUser.email,
      fullName: dbUser.fullName,
      phone: dbUser.phone,
      roles: dbUser.userRoles.map((ur) => ur.role.code),
      tenant: dbUser.tenant,
      store: dbUser.primaryStore,
      lastLoginAt: dbUser.lastLoginAt,
    };
  }

  private async issueTokens(user: AuthUser) {
    const jti = randomUUID();
    const base = {
      sub: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles,
      storeId: user.storeId ?? null,
    };

    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');

    const accessToken = await this.jwt.signAsync(
      { ...base, typ: 'access', jti } as JwtPayload & { jti: string },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl as `${number}m` | `${number}d` | `${number}h`,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { ...base, typ: 'refresh', jti } as JwtPayload & { jti: string },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtl as `${number}m` | `${number}d` | `${number}h`,
      },
    );

    const refreshMs = this.parseTtlToMs(refreshTtl);
    await this.prisma.user.update({
      where: { id: user.userId },
      data: {
        refreshTokenHash: this.hashToken(refreshToken),
        refreshTokenExpiresAt: new Date(Date.now() + refreshMs),
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async clearRefreshToken(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
      },
    });
  }

  private parseTtlToMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const n = Number(match[1]);
    const unit = match[2];
    const mult =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
    return n * mult;
  }

  private async safeAuditFailedLogin(
    tenantId: string | undefined,
    email: string,
    reason: string,
  ) {
    if (!tenantId) return;
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          entityType: 'auth',
          action: 'auth.login_failed',
          beforeAfter: { email, reason },
        },
      });
    } catch {
      // ignore audit failures
    }
  }
}
