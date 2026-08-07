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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { provisionTenantWithAdmin } from '../../common/provision-tenant';
import type {
  LoginDto,
  RefreshTokenDto,
  RegisterTenantDto,
  RegisterUserDto,
} from './dto/auth.dto';
import { RESERVED_TENANT_SLUGS } from './password.policy';
import type { AuthUser, JwtPayload } from './types';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
const DEFAULT_SELF_REGISTER_ROLE = 'staff';

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
    const locationName = dto.storeName.trim();
    const taxId = dto.gstin?.trim() || dto.taxId?.trim();

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

    const result = await this.prisma.$transaction(async (tx) =>
      provisionTenantWithAdmin(tx, {
        tenantName,
        slug,
        taxId,
        locationName,
        adminEmail: email,
        adminFullName: fullName,
        adminPhone: dto.adminPhone,
        passwordHash,
      }),
    );

    const tokens = await this.issueTokens({
      userId: result.user.id,
      tenantId: result.tenant.id,
      email: result.user.email,
      fullName: result.user.fullName,
      locationId: result.location.id,
      storeId: result.location.id,
      roles: result.roles,
    });

    return {
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
      organization: {
        id: result.organization.id,
        name: result.organization.name,
        code: result.organization.code,
      },
      location: {
        id: result.location.id,
        name: result.location.name,
        code: result.location.code,
        type: result.location.type,
      },
      /** @deprecated alias — use location */
      store: {
        id: result.location.id,
        name: result.location.name,
        code: result.location.code,
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

  async registerUser(dto: RegisterUserDto) {
    const slug = dto.tenantSlug.trim().toLowerCase();
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const roleCode = DEFAULT_SELF_REGISTER_ROLE;

    if (dto.password.toLowerCase().includes(slug)) {
      throw new BadRequestException('Password must not contain tenant slug');
    }
    if (dto.password.toLowerCase().includes(email.split('@')[0])) {
      throw new BadRequestException(
        'Password must not contain email local-part',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.status !== 'active') {
      throw new BadRequestException('Shop not found or inactive');
    }

    const existing = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    const location = await this.prisma.location.findFirst({
      where: { tenantId: tenant.id, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, code: true },
    });

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const employeeCount = await this.prisma.employee.count({
      where: { tenantId: tenant.id },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: {
          tenantId_code: { tenantId: tenant.id, code: roleCode },
        },
        create: {
          tenantId: tenant.id,
          code: roleCode,
          name: roleCode,
        },
        update: {},
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          phone: dto.phone,
          fullName,
          passwordHash,
          primaryLocationId: location?.id,
          isActive: true,
          passwordChangedAt: new Date(),
          lastLoginAt: new Date(),
        },
      });

      await tx.employee.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          employeeCode: `E${String(employeeCount + 1).padStart(3, '0')}`,
          status: 'active',
          hiredAt: new Date(),
          jobTitle: 'Staff',
        },
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          locationId: location?.id ?? null,
        },
      });

      if (location) {
        await tx.membership.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            locationId: location.id,
            roleId: role.id,
            status: 'active',
          },
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          action: 'auth.register_user',
        },
      });

      return user;
    });

    const roles = [roleCode];
    const locationId = location?.id ?? null;
    const tokens = await this.issueTokens({
      userId: created.id,
      tenantId: tenant.id,
      email: created.email,
      fullName: created.fullName,
      locationId,
      storeId: locationId,
      roles,
    });

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      location: location
        ? { id: location.id, name: location.name, code: location.code }
        : null,
      store: location
        ? { id: location.id, name: location.name, code: location.code }
        : null,
      user: {
        id: created.id,
        email: created.email,
        fullName: created.fullName,
        roles,
        locationId,
        storeId: locationId,
        tenantId: tenant.id,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    const password = dto.password;
    const slug = dto.tenantSlug?.trim().toLowerCase();

    type UserWithTenant = Prisma.UserGetPayload<{
      include: { userRoles: { include: { role: true } }; tenant: true };
    }>;

    let user: UserWithTenant | null = null;
    let passwordOk = false;

    if (slug) {
      const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
      user =
        tenant && tenant.status === 'active'
          ? await this.prisma.user.findFirst({
              where: { tenantId: tenant.id, email },
              include: {
                userRoles: { include: { role: true } },
                tenant: true,
              },
            })
          : null;
      const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      passwordOk = await bcrypt.compare(password, hash);
    } else {
      const candidates = await this.prisma.user.findMany({
        where: {
          email,
          isActive: true,
          tenant: { status: 'active' },
        },
        include: {
          userRoles: { include: { role: true } },
          tenant: true,
        },
        take: 8,
      });
      for (const candidate of candidates) {
        const ok = await bcrypt.compare(password, candidate.passwordHash);
        if (ok) {
          user = candidate;
          passwordOk = true;
          break;
        }
      }
      if (!user) {
        // Keep timing consistent + enable lockout on known email
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        user = candidates[0] ?? null;
        passwordOk = false;
      }
    }

    if (!user || !user.isActive || user.tenant.status !== 'active') {
      await this.safeAuditFailedLogin(user?.tenantId, email, 'user_or_tenant');
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
    const locationId = user.primaryLocationId;
    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      locationId,
      storeId: locationId,
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
        locationId,
        storeId: locationId,
        tenantId: user.tenantId,
      },
      tenant: {
        id: user.tenant.id,
        slug: user.tenant.slug,
        name: user.tenant.name,
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

    const locationId = user.primaryLocationId;
    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      locationId,
      storeId: locationId,
      roles: user.userRoles.map((ur) => ur.role.code),
    };

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
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            currencyCode: true,
            locale: true,
            timezone: true,
            taxMode: true,
            branding: true,
          },
        },
        primaryLocation: {
          select: { id: true, name: true, code: true, type: true },
        },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            jobTitle: true,
            status: true,
          },
        },
        userRoles: { include: { role: true } },
        memberships: {
          where: { status: 'active' },
          select: {
            id: true,
            locationId: true,
            departmentId: true,
            teamId: true,
            role: { select: { code: true } },
          },
        },
      },
    });

    if (!dbUser || dbUser.tenant.status !== 'active') {
      throw new UnauthorizedException();
    }

    const modules = await this.prisma.tenantModule.findMany({
      where: { tenantId: user.tenantId, status: 'enabled' },
      include: {
        module: {
          select: {
            code: true,
            name: true,
            navSchema: true,
            dependsOn: true,
          },
        },
      },
    });

    return {
      id: dbUser.id,
      email: dbUser.email,
      fullName: dbUser.fullName,
      phone: dbUser.phone,
      roles: dbUser.userRoles.map((ur) => ur.role.code),
      tenant: dbUser.tenant,
      location: dbUser.primaryLocation,
      store: dbUser.primaryLocation,
      employee: dbUser.employee,
      memberships: dbUser.memberships,
      modules: modules.map((m) => ({
        code: m.module.code,
        name: m.module.name,
        navSchema: m.module.navSchema,
        dependsOn: m.module.dependsOn,
        config: m.config,
      })),
      lastLoginAt: dbUser.lastLoginAt,
    };
  }

  private async issueTokens(user: AuthUser) {
    const jti = randomUUID();
    const locationId = user.locationId ?? user.storeId ?? null;
    const base = {
      sub: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles,
      locationId,
      storeId: locationId,
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
