import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { RoleGroup } from '../../common/roles';
import { expandPermissions } from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import { provisionTenantWithAdmin } from '../../common/provision-tenant';
import type {
  GoogleAuthDto,
  LoginDto,
  PinLoginDto,
  RefreshTokenDto,
  RegisterTenantDto,
  RegisterUserDto,
  SetPinDto,
} from './dto/auth.dto';
import { assertPinAllowed, isPinSwitchEnabled } from './pin.policy';
import { RESERVED_TENANT_SLUGS } from './password.policy';
import type { AuthUser, JwtPayload, JwtTokenTyp } from './types';
import { PortalAuthService } from './portal-auth.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MAX_PIN_FAILED_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
const DEFAULT_SELF_REGISTER_ROLE = 'staff';
/** Burst of failed PIN attempts at one station before temporary station lock */
const STATION_PIN_BURST_LIMIT = 20;
const STATION_PIN_BURST_WINDOW_MS = 10 * 60 * 1000;

/** Valid bcrypt hash used only to keep login timing consistent */
const DUMMY_PASSWORD_HASH =
  '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW';
/** Same dummy shape for PIN compare-on-miss */
const DUMMY_PIN_HASH = DUMMY_PASSWORD_HASH;

type StationPinBucket = { count: number; resetAt: number };
const stationPinFailures = new Map<string, StationPinBucket>();

type GoogleTokenInfo = {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  sub?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly portal: PortalAuthService,
  ) {}

  async registerTenant(dto: RegisterTenantDto) {
    const email = dto.adminEmail.trim().toLowerCase();
    const fullName = dto.adminFullName.trim();
    const tenantName = dto.tenantName.trim();
    const locationName = (dto.storeName?.trim() || tenantName).trim();
    const taxId = dto.gstin?.trim() || dto.taxId?.trim();

    let slug =
      dto.tenantSlug?.trim().toLowerCase() ||
      tenantName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    if (slug.length < 2) {
      slug = `shop-${Date.now().toString(36)}`;
    }

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

    // If slug taken, append short suffix
    let existing = await this.prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      const suffix = Date.now().toString(36).slice(-4);
      slug = `${slug.slice(0, 45)}-${suffix}`;
      existing = await this.prisma.tenant.findUnique({ where: { slug } });
      if (existing) {
        throw new ConflictException('Tenant slug already taken');
      }
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

    await this.portal.ensureAfterTenantRegister({
      email,
      fullName,
      phone: dto.adminPhone,
      passwordHash,
      tenantId: result.tenant.id,
      userId: result.user.id,
    });

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

  async googleAuth(dto: GoogleAuthDto) {
    const profile = await this.verifyGoogleIdToken(dto.idToken);
    const email = profile.email!.trim().toLowerCase();
    const fullName = (profile.name || email.split('@')[0] || 'Owner').trim();
    const googleSub = profile.sub || email;

    // Always land on organization picker (Zoho flow)
    return this.portal.googlePortal({
      email,
      fullName,
      googleSub,
    });
  }

  private async verifyGoogleIdToken(idToken: string): Promise<GoogleTokenInfo> {
    const clientId =
      this.config.get<string>('GOOGLE_CLIENT_ID')?.trim() ||
      this.config.get<string>('NEXT_PUBLIC_GOOGLE_CLIENT_ID')?.trim();
    if (!clientId) {
      throw new BadRequestException(
        'Google sign-in is not configured on the server (GOOGLE_CLIENT_ID)',
      );
    }

    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new UnauthorizedException('Could not verify Google token');
    }
    if (!res.ok) {
      throw new UnauthorizedException('Invalid Google token');
    }
    const payload = (await res.json()) as GoogleTokenInfo;
    if (!payload.email || payload.aud !== clientId) {
      throw new UnauthorizedException('Google token audience mismatch');
    }
    const verified =
      payload.email_verified === true || payload.email_verified === 'true';
    if (!verified) {
      throw new UnauthorizedException('Google email is not verified');
    }
    return payload;
  }

  async login(dto: LoginDto) {
    // Zoho portal path (no slug): identity → organizations
    if (!dto.tenantSlug?.trim()) {
      const portal = await this.portal.loginPortal({
        email: dto.email,
        password: dto.password,
      });
      if (portal) return portal;
    }

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

    // Link identity for future portal logins
    await this.portal
      .ensureAfterTenantRegister({
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        passwordHash: user.passwordHash,
        tenantId: user.tenantId,
        userId: user.id,
      })
      .catch(() => null);

    const roles = user.userRoles.map((ur) => ur.role.code);
    const permissions = await this.loadPermissionsForUser(user.id, roles);
    const locationId = user.primaryLocationId;
    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      locationId,
      storeId: locationId,
      roles,
      permissions,
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
      stage: 'app' as const,
      requiresOrganizationSelection: false,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roles,
        permissions,
        locationId,
        storeId: locationId,
        tenantId: user.tenantId,
        pinSet: Boolean(user.pinHash),
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
            settings: true,
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

    const { settings: tenantSettings, ...tenantRest } = dbUser.tenant;

    const roles = dbUser.userRoles.map((ur) => ur.role.code);
    const roleIds = dbUser.userRoles.map((ur) => ur.roleId);
    const permRows =
      roleIds.length > 0
        ? await this.prisma.rolePermission.findMany({
            where: { roleId: { in: roleIds } },
            select: { permission: { select: { code: true } } },
          })
        : [];
    const permissions = expandPermissions(
      roles,
      permRows.map((r) => r.permission.code),
    );

    return {
      id: dbUser.id,
      email: dbUser.email,
      fullName: dbUser.fullName,
      phone: dbUser.phone,
      roles,
      permissions,
      pinSet: Boolean(dbUser.pinHash),
      pinSwitchEnabled: isPinSwitchEnabled(tenantSettings),
      tenant: tenantRest,
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

  async setOwnPin(actor: AuthUser, dto: SetPinDto) {
    await this.assertPinSwitchOn(actor.tenantId);
    assertPinAllowed(dto.pin);
    const locationId = actor.locationId ?? null;
    await this.applyPinToUser({
      tenantId: actor.tenantId,
      targetUserId: actor.userId,
      pin: dto.pin,
      locationId,
      actorUserId: actor.userId,
      action: 'auth.pin_set_self',
    });
    return { pinSet: true };
  }

  async setUserPin(actor: AuthUser, targetUserId: string, dto: SetPinDto) {
    await this.assertPinSwitchOn(actor.tenantId);
    const canManage = RoleGroup.staff.some((r) => actor.roles.includes(r));
    if (!canManage) {
      throw new ForbiddenException('Only admin/manager can set staff PINs');
    }
    assertPinAllowed(dto.pin);

    const target = await this.prisma.user.findFirst({
      where: {
        id: targetUserId,
        tenantId: actor.tenantId,
        isActive: true,
      },
      select: { id: true, primaryLocationId: true },
    });
    if (!target) {
      throw new BadRequestException('Staff member not found');
    }

    await this.applyPinToUser({
      tenantId: actor.tenantId,
      targetUserId: target.id,
      pin: dto.pin,
      locationId: target.primaryLocationId,
      actorUserId: actor.userId,
      action: 'auth.pin_set_by_manager',
    });
    return { pinSet: true };
  }

  async listPinStaff(actor: AuthUser, locationId: string) {
    await this.assertPinSwitchOn(actor.tenantId);
    if (actor.tokenTyp !== 'station' && actor.tokenTyp !== 'access') {
      // pin_access may list peers at the same counter
      if (actor.tokenTyp !== 'pin_access') {
        throw new UnauthorizedException('Station session required');
      }
    }

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: actor.tenantId, isActive: true },
      select: { id: true },
    });
    if (!location) {
      throw new BadRequestException('Location not found');
    }

    const rows = await this.prisma.user.findMany({
      where: {
        tenantId: actor.tenantId,
        isActive: true,
        primaryLocationId: locationId,
      },
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        email: true,
        pinHash: true,
        userRoles: { select: { role: { select: { code: true } } } },
      },
    });

    return rows.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      roles: u.userRoles.map((ur) => ur.role.code),
      pinSet: Boolean(u.pinHash),
    }));
  }

  async pinLogin(actor: AuthUser, dto: PinLoginDto) {
    if (actor.tokenTyp !== 'station') {
      throw new UnauthorizedException(
        'PIN login requires an unlocked station session',
      );
    }
    await this.assertPinSwitchOn(actor.tenantId);

    const stationKey = `${actor.tenantId}:${dto.locationId}`;
    this.assertStationPinNotBurstLocked(stationKey);

    const location = await this.prisma.location.findFirst({
      where: {
        id: dto.locationId,
        tenantId: actor.tenantId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!location) {
      throw new BadRequestException('Location not found');
    }

    const target = await this.prisma.user.findFirst({
      where: {
        id: dto.userId,
        tenantId: actor.tenantId,
        isActive: true,
        primaryLocationId: dto.locationId,
      },
      include: {
        userRoles: { include: { role: true } },
        tenant: { select: { id: true, slug: true, name: true, status: true } },
      },
    });

    const hash = target?.pinHash ?? DUMMY_PIN_HASH;
    const pinOk = await bcrypt.compare(dto.pin, hash);

    if (
      !target ||
      !target.pinHash ||
      target.tenant.status !== 'active' ||
      !pinOk
    ) {
      this.recordStationPinFailure(stationKey);
      if (target?.pinHash) {
        await this.bumpPinFailures(target);
      } else {
        await bcrypt.compare(dto.pin, DUMMY_PIN_HASH);
      }
      await this.prisma.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          entityType: 'auth',
          entityId: dto.userId,
          action: 'auth.pin_login_failed',
          beforeAfter: { locationId: dto.locationId },
        },
      });
      throw new UnauthorizedException('Invalid PIN');
    }

    if (target.pinLockedUntil && target.pinLockedUntil > new Date()) {
      throw new UnauthorizedException(
        'PIN temporarily locked. Ask a manager to reset, or try later.',
      );
    }

    const roles = target.userRoles.map((ur) => ur.role.code);
    const authUser: AuthUser = {
      userId: target.id,
      tenantId: target.tenantId,
      email: target.email,
      fullName: target.fullName,
      locationId: target.primaryLocationId,
      storeId: target.primaryLocationId,
      roles,
    };

    const accessToken = await this.signAccessLike(
      authUser,
      'pin_access',
      this.config.get<string>('JWT_PIN_ACCESS_TTL', '10h'),
    );

    await this.prisma.user.update({
      where: { id: target.id },
      data: {
        failedPinAttempts: 0,
        pinLockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    this.clearStationPinFailures(stationKey);

    await this.prisma.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: target.id,
        entityType: 'user',
        entityId: target.id,
        action: 'auth.pin_login',
        beforeAfter: { locationId: dto.locationId },
      },
    });

    // Do NOT open RegisterSession — only attribute via acting JWT userId
    return {
      user: {
        id: target.id,
        email: target.email,
        fullName: target.fullName,
        roles,
        locationId: target.primaryLocationId,
        storeId: target.primaryLocationId,
        tenantId: target.tenantId,
        pinSet: true,
      },
      accessToken,
    };
  }

  private async assertPinSwitchOn(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true, status: true },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedException();
    }
    if (!isPinSwitchEnabled(tenant.settings)) {
      throw new BadRequestException('PIN staff switch is disabled for this shop');
    }
  }

  private async applyPinToUser(args: {
    tenantId: string;
    targetUserId: string;
    pin: string;
    locationId: string | null;
    actorUserId: string;
    action: string;
  }) {
    if (args.locationId) {
      const peers = await this.prisma.user.findMany({
        where: {
          tenantId: args.tenantId,
          isActive: true,
          primaryLocationId: args.locationId,
          id: { not: args.targetUserId },
          pinHash: { not: null },
        },
        select: { id: true, pinHash: true },
      });
      for (const peer of peers) {
        if (!peer.pinHash) continue;
        const same = await bcrypt.compare(args.pin, peer.pinHash);
        if (same) {
          throw new ConflictException(
            'Another staff member at this location already uses this PIN',
          );
        }
      }
    }

    const pinHash = await bcrypt.hash(args.pin, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: args.targetUserId },
      data: {
        pinHash,
        pinSetAt: new Date(),
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        entityType: 'user',
        entityId: args.targetUserId,
        action: args.action,
        // Never store the PIN value
        beforeAfter: { pinSet: true },
      },
    });
  }

  private async bumpPinFailures(
    user: { id: string; tenantId: string; failedPinAttempts: number },
  ) {
    const attempts = user.failedPinAttempts + 1;
    const pinLockedUntil =
      attempts >= MAX_PIN_FAILED_ATTEMPTS
        ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000)
        : null;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedPinAttempts: attempts,
        pinLockedUntil: pinLockedUntil ?? undefined,
      },
    });
    if (pinLockedUntil) {
      throw new UnauthorizedException(
        'Too many failed PIN attempts. Locked for 15 minutes.',
      );
    }
  }

  private assertStationPinNotBurstLocked(stationKey: string) {
    const bucket = stationPinFailures.get(stationKey);
    if (!bucket) return;
    if (Date.now() > bucket.resetAt) {
      stationPinFailures.delete(stationKey);
      return;
    }
    if (bucket.count >= STATION_PIN_BURST_LIMIT) {
      throw new UnauthorizedException(
        'Too many PIN attempts at this counter. Wait a few minutes.',
      );
    }
  }

  private recordStationPinFailure(stationKey: string) {
    const now = Date.now();
    const existing = stationPinFailures.get(stationKey);
    if (!existing || now > existing.resetAt) {
      stationPinFailures.set(stationKey, {
        count: 1,
        resetAt: now + STATION_PIN_BURST_WINDOW_MS,
      });
      return;
    }
    existing.count += 1;
  }

  private clearStationPinFailures(stationKey: string) {
    stationPinFailures.delete(stationKey);
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
    const stationTtl = this.config.get<string>('JWT_STATION_TTL', '12h');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');

    const accessToken = await this.jwt.signAsync(
      { ...base, typ: 'access', jti } as JwtPayload & { jti: string },
      {
        secret: accessSecret,
        expiresIn: accessTtl as `${number}m` | `${number}d` | `${number}h`,
      },
    );

    const stationToken = await this.jwt.signAsync(
      {
        ...base,
        typ: 'station',
        jti: randomUUID(),
      } as JwtPayload & { jti: string },
      {
        secret: accessSecret,
        expiresIn: stationTtl as `${number}m` | `${number}d` | `${number}h`,
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

    return { accessToken, stationToken, refreshToken };
  }

  private async signAccessLike(
    user: AuthUser,
    typ: Extract<JwtTokenTyp, 'access' | 'pin_access'>,
    ttl: string,
  ) {
    const locationId = user.locationId ?? user.storeId ?? null;
    return this.jwt.signAsync(
      {
        sub: user.userId,
        tenantId: user.tenantId,
        email: user.email,
        roles: user.roles,
        locationId,
        storeId: locationId,
        typ,
        jti: randomUUID(),
      } as JwtPayload & { jti: string },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: ttl as `${number}m` | `${number}d` | `${number}h`,
      },
    );
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

  /**
   * Build full shop session for an existing user (password, Google, biometric).
   */
  async issueSessionForUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, tenant: { status: 'active' } },
      include: {
        tenant: true,
        userRoles: { include: { role: true } },
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const roles = user.userRoles.map((ur) => ur.role.code);
    const permissions = await this.loadPermissionsForUser(
      user.id,
      roles,
    );
    const locationId = user.primaryLocationId;
    const authUser: AuthUser = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      locationId,
      storeId: locationId,
      roles,
      permissions,
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

    return {
      stage: 'app' as const,
      requiresOrganizationSelection: false,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roles,
        permissions,
        locationId,
        storeId: locationId,
        tenantId: user.tenantId,
        pinSet: Boolean(user.pinHash),
      },
      tenant: {
        id: user.tenant.id,
        slug: user.tenant.slug,
        name: user.tenant.name,
      },
      ...tokens,
    };
  }

  private async loadPermissionsForUser(userId: string, roles: string[]) {
    const roleIds = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });
    const ids = roleIds.map((r) => r.roleId);
    const permRows =
      ids.length > 0
        ? await this.prisma.rolePermission.findMany({
            where: { roleId: { in: ids } },
            select: { permission: { select: { code: true } } },
          })
        : [];
    return expandPermissions(
      roles,
      permRows.map((r) => r.permission.code),
    );
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
