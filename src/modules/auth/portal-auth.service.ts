import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { provisionTenantWithAdmin, enableTenantModules } from '../../common/provision-tenant';
import {
  getBusinessConfig,
  isBusinessTypeId,
  registryToDbPayload,
} from '../../common/business-config';
import { isCommerceMode, moduleStackForMode } from '../../common/commerce-schema';
import { expandPermissions } from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import { RESERVED_TENANT_SLUGS } from './password.policy';
import type {
  CreateOrganizationDto,
  SignupIdentityDto,
} from './dto/auth.dto';
import { AuthService } from './auth.service';
import { SecurityService } from '../security/security.service';
import { rethrowAuthDb, safePasswordMatch } from './auth-db-error';

const BCRYPT_ROUNDS = 12;
const DUMMY_PASSWORD_HASH =
  '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW';

type OrgRow = {
  tenantId: string;
  name: string;
  slug: string;
  currencyCode: string;
  role?: string;
};

@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AuthService))
    private readonly auth: AuthService,
    private readonly security: SecurityService,
  ) {}

  // ── Public portal entrypoints ───────────────────────────────────────

  async signupIdentity(dto: SignupIdentityDto) {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const phone = dto.phone?.trim();

    const exists = await this.prisma.identityAccount.findUnique({
      where: { email },
    });
    if (exists) {
      throw new ConflictException(
        'An account with this email already exists. Sign in instead.',
      );
    }

    // Also block if they already have a shop under this email without identity
    const userHit = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      select: { id: true },
    });
    if (userHit) {
      throw new ConflictException(
        'This email already has a shop. Sign in to open your organizations.',
      );
    }

    if (dto.password.toLowerCase().includes(email.split('@')[0] ?? '')) {
      throw new BadRequestException(
        'Password must not contain email local-part',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const identity = await this.prisma.identityAccount.create({
      data: {
        email,
        fullName,
        phone,
        passwordHash,
      },
    });

    return this.portalSession(identity.id);
  }

  /**
   * Email/password → identity session + org list (Zoho organizations step).
   * Optional tenantSlug still jumps straight into that shop when password matches.
   */
  async loginPortal(params: {
    email: string;
    password: string;
    tenantSlug?: string;
  }) {
    const email = params.email.trim().toLowerCase();
    const password = params.password;

    // Legacy direct-into-shop when slug provided
    if (params.tenantSlug?.trim()) {
      return null; // signal AuthService to use legacy login
    }

    let identity = await this.prisma.identityAccount.findUnique({
      where: { email },
    });

    // Discover tenant users with this email
    const candidates = await this.prisma.user.findMany({
      where: { email, isActive: true, tenant: { status: 'active' } },
      include: {
        tenant: true,
        userRoles: { include: { role: true } },
      },
      take: 20,
    });

    let passwordOk = false;
    if (identity?.passwordHash) {
      passwordOk = await safePasswordMatch(password, identity.passwordHash);
    }

    // Migrate / link from tenant users if identity missing or no hash
    if (!passwordOk) {
      for (const c of candidates) {
        if (await safePasswordMatch(password, c.passwordHash)) {
          passwordOk = true;
          if (!identity) {
            identity = await this.prisma.identityAccount.create({
              data: {
                email,
                fullName: c.fullName,
                phone: c.phone,
                passwordHash: c.passwordHash,
              },
            });
          } else if (!identity.passwordHash) {
            identity = await this.prisma.identityAccount.update({
              where: { id: identity.id },
              data: { passwordHash: c.passwordHash },
            });
          }
          await this.linkUser(identity.id, c.tenantId, c.id);
          break;
        }
      }
    }

    if (!passwordOk) {
      await safePasswordMatch(password, DUMMY_PASSWORD_HASH);
      if (identity) {
        await this.bumpIdentityFail(identity.id, identity.failedLoginAttempts);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!identity) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (identity.lockedUntil && identity.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Account temporarily locked. Try again later.',
      );
    }

    // Link all same-email users where the shared password works
    for (const c of candidates) {
      if (await safePasswordMatch(password, c.passwordHash)) {
        await this.linkUser(identity.id, c.tenantId, c.id);
      }
    }

    await this.prisma.identityAccount.update({
      where: { id: identity.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    return this.portalSession(identity.id);
  }

  async googlePortal(params: {
    email: string;
    fullName: string;
    googleSub: string;
  }) {
    const email = params.email.trim().toLowerCase();
    let identity = await this.prisma.identityAccount.findFirst({
      where: {
        OR: [{ email }, { googleSub: params.googleSub }],
      },
    });

    if (!identity) {
      identity = await this.prisma.identityAccount.create({
        data: {
          email,
          fullName: params.fullName,
          googleSub: params.googleSub,
          passwordHash: null,
        },
      });
    } else {
      identity = await this.prisma.identityAccount.update({
        where: { id: identity.id },
        data: {
          googleSub: identity.googleSub ?? params.googleSub,
          fullName: identity.fullName || params.fullName,
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    }

    // Link every existing user with this email
    const users = await this.prisma.user.findMany({
      where: { email, isActive: true, tenant: { status: 'active' } },
      select: { id: true, tenantId: true },
    });
    for (const u of users) {
      await this.linkUser(identity.id, u.tenantId, u.id);
    }

    return this.portalSession(identity.id);
  }

  async listOrganizations(identityId: string) {
    return this.portalSession(identityId);
  }

  async createOrganization(identityId: string, dto: CreateOrganizationDto) {
    const identity = await this.prisma.identityAccount.findUnique({
      where: { id: identityId },
    });
    if (!identity) throw new UnauthorizedException('Identity not found');

    const organizationName = dto.organizationName.trim();
    const locationName = (dto.storeName?.trim() || organizationName).trim();
    const taxId = dto.taxId?.trim();

    let slug =
      dto.tenantSlug?.trim().toLowerCase() ||
      organizationName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    if (slug.length < 2) slug = `shop-${Date.now().toString(36)}`;
    if (RESERVED_TENANT_SLUGS.has(slug)) {
      throw new BadRequestException('This organization slug is reserved');
    }

    let existing = await this.prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      slug = `${slug.slice(0, 45)}-${Date.now().toString(36).slice(-4)}`;
    }

    const passwordHash =
      identity.passwordHash ??
      (await bcrypt.hash(randomBytes(24).toString('base64url') + 'Aa1!', BCRYPT_ROUNDS));

    const currencyCode = (dto.currencyCode?.trim() || 'INR').toUpperCase();
    const locale = dto.locale?.trim() || 'en-IN';

    if (!isBusinessTypeId(dto.businessType)) {
      throw new BadRequestException(
        'Unknown business type. Choose retail, grocery, restaurant, salon, service, other, or general.',
      );
    }
    const profile = getBusinessConfig(dto.businessType);
    const configPayload = registryToDbPayload(profile);

    // Other / general: optional merchant-defined item fields
    if (
      (profile.id === 'other' || profile.id === 'general') &&
      Array.isArray(dto.customItemFields) &&
      dto.customItemFields.length
    ) {
      const seen = new Set<string>();
      for (const row of dto.customItemFields) {
        const label = row.label?.trim();
        if (!label) continue;
        let key = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40);
        if (!key || seen.has(key)) key = `custom_${seen.size + 1}`;
        seen.add(key);
        configPayload.itemFields.push({
          entity: 'item',
          key,
          label,
          type: 'string',
          required: false,
        });
      }
    }

    let modes = profile.defaultCommerceModes.filter(isCommerceMode);
    if (!modes.length) modes = ['sale'];
    const modeModuleCodes = [
      ...new Set(modes.flatMap((m) => [...moduleStackForMode(m)])),
    ];

    let result: Awaited<ReturnType<typeof provisionTenantWithAdmin>>;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const provisioned = await provisionTenantWithAdmin(tx, {
          tenantName: organizationName,
          slug,
          taxId,
          locationName,
          adminEmail: identity.email,
          adminFullName: identity.fullName,
          adminPhone: dto.phone?.trim() || identity.phone || undefined,
          passwordHash,
          currencyCode,
          locale,
        });

        // Zoho-style org profile + universal BusinessConfig link
        const settings = {
          ...((provisioned.tenant.settings as Record<string, unknown>) ?? {}),
          businessType: profile.id,
          businessConfigId: profile.id,
          businessConfigSetAt: new Date().toISOString(),
          commerceModes: modes,
          commerceSetupAt: new Date().toISOString(),
          pos: { pinSwitchEnabled: true },
          /** Exclusive tax by default so Due = Subtotal + Tax at counter */
          tax: {
            ratePercent: provisioned.tenant.taxMode === 'none' ? 0 : 5,
            inclusive: false,
          },
          organizationProfile: {
            phone: dto.phone?.trim() || identity.phone || null,
            addressLine1: dto.addressLine1?.trim() || null,
            city: dto.city?.trim() || null,
            state: dto.state?.trim() || null,
            postalCode: dto.postalCode?.trim() || null,
            countryCode: (dto.countryCode?.trim() || 'IN').toUpperCase(),
            fiscalYearStart: dto.fiscalYearStart?.trim() || null,
            inventoryStartDate: dto.inventoryStartDate || null,
          },
        };

        await tx.tenant.update({
          where: { id: provisioned.tenant.id },
          data: { settings: settings as Prisma.InputJsonValue },
        });

        await tx.businessConfig.create({
          data: {
            tenantId: provisioned.tenant.id,
            businessType: configPayload.businessType,
            itemFields: configPayload.itemFields as Prisma.InputJsonValue,
            orderFields: configPayload.orderFields as Prisma.InputJsonValue,
            uiFlow: configPayload.uiFlow as Prisma.InputJsonValue,
            billing: configPayload.billing as Prisma.InputJsonValue,
          },
        });

        if (modeModuleCodes.length) {
          await enableTenantModules(tx, provisioned.tenant.id, modeModuleCodes);
        }

        await tx.identityTenantMembership.create({
          data: {
            identityId: identity.id,
            tenantId: provisioned.tenant.id,
            userId: provisioned.user.id,
          },
        });

        return provisioned;
      });
    } catch (e) {
      this.logger.error(
        'Create organization failed',
        e instanceof Error ? e.stack : String(e),
      );
      rethrowAuthDb(e);
    }

    // Auto-enter the new shop (Zoho "Get Started")
    return this.enterOrganization(identityId, result.tenant.id);
  }

  async selectOrganization(
    identityId: string,
    tenantId: string,
    ip?: string,
  ) {
    return this.enterOrganization(identityId, tenantId, ip);
  }

  async requireIdentityFromAuthHeader(authHeader?: string) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing identity token');
    }
    const token = authHeader.slice(7).trim();
    return this.requireIdentityToken(token);
  }

  async requireIdentityToken(token: string) {
    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired identity session');
    }
    if (payload.typ !== 'identity' || !payload.sub) {
      throw new UnauthorizedException('Not an identity session');
    }
    const identity = await this.prisma.identityAccount.findFirst({
      where: { id: payload.sub },
    });
    if (!identity) throw new UnauthorizedException('Identity not found');
    return identity;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async portalSession(identityId: string) {
    const identity = await this.prisma.identityAccount.findUniqueOrThrow({
      where: { id: identityId },
      include: {
        memberships: {
          include: {
            tenant: true,
            user: {
              include: { userRoles: { include: { role: true } } },
            },
          },
        },
      },
    });

    const organizations: OrgRow[] = identity.memberships
      .filter(
        (m) =>
          m.tenant?.status === 'active' && Boolean(m.user?.isActive),
      )
      .map((m) => ({
        tenantId: m.tenantId,
        name: m.tenant.name,
        slug: m.tenant.slug,
        currencyCode: m.tenant.currencyCode,
        role: m.user.userRoles[0]?.role.code,
      }));

    const identityTokens = await this.issueIdentityTokens(identity.id);

    return {
      stage: 'select_org' as const,
      requiresOrganizationSelection: true,
      identity: {
        id: identity.id,
        email: identity.email,
        fullName: identity.fullName,
        phone: identity.phone,
      },
      organizations,
      identityToken: identityTokens.identityToken,
      identityRefreshToken: identityTokens.identityRefreshToken,
      // No tenant access tokens until org selected
      accessToken: null as string | null,
      stationToken: null as string | null,
      refreshToken: null as string | null,
    };
  }

  private async enterOrganization(
    identityId: string,
    tenantId: string,
    ip?: string,
  ) {
    const membership = await this.prisma.identityTenantMembership.findFirst({
      where: { identityId, tenantId },
      include: {
        user: {
          include: {
            userRoles: { include: { role: true } },
            tenant: true,
          },
        },
        tenant: true,
      },
    });
    if (!membership || !membership.user.isActive) {
      throw new UnauthorizedException('You do not have access to this shop');
    }
    if (membership.tenant.status !== 'active') {
      throw new UnauthorizedException('This organization is not active');
    }

    const user = membership.user;
    if (ip) {
      await this.security.assertTenantIp(user.tenantId, ip);
    }
    if (user.totpEnabled) {
      return this.auth.issueTotpChallenge({
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        fullName: user.fullName,
        identityId,
      });
    }

    const roles = user.userRoles.map((ur) => ur.role.code);
    const roleIds = user.userRoles.map((ur) => ur.roleId);
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
    const locationId = user.primaryLocationId;

    const tokens = await this.issueTenantTokens({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      roles,
      locationId,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await this.prisma.identityAccount.update({
      where: { id: identityId },
      data: { lastLoginAt: new Date() },
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
        id: membership.tenant.id,
        slug: membership.tenant.slug,
        name: membership.tenant.name,
      },
      ...tokens,
    };
  }

  private async linkUser(identityId: string, tenantId: string, userId: string) {
    try {
      await this.prisma.identityTenantMembership.upsert({
        where: { userId },
        create: { identityId, tenantId, userId },
        update: { identityId, tenantId },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `Identity membership already exists identity=${identityId} tenant=${tenantId}`,
        );
        return;
      }
      throw e;
    }
  }

  private async bumpIdentityFail(id: string, current: number) {
    const attempts = current + 1;
    await this.prisma.identityAccount.update({
      where: { id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= 5
            ? new Date(Date.now() + 15 * 60 * 1000)
            : undefined,
      },
    });
  }

  private async issueIdentityTokens(identityId: string) {
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    const identity = await this.prisma.identityAccount.findUniqueOrThrow({
      where: { id: identityId },
    });

    const identityToken = await this.jwt.signAsync(
      {
        sub: identity.id,
        email: identity.email,
        typ: 'identity',
        jti: randomUUID(),
      },
      {
        secret: accessSecret,
        expiresIn: '2h',
      },
    );

    const identityRefreshToken = await this.jwt.signAsync(
      {
        sub: identity.id,
        email: identity.email,
        typ: 'identity_refresh',
        jti: randomUUID(),
      },
      {
        secret: refreshSecret,
        expiresIn: '7d',
      },
    );

    await this.prisma.identityAccount.update({
      where: { id: identity.id },
      data: {
        refreshTokenHash: createHash('sha256')
          .update(identityRefreshToken)
          .digest('hex'),
        refreshTokenExpiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });

    return { identityToken, identityRefreshToken };
  }

  private async issueTenantTokens(user: {
    userId: string;
    tenantId: string;
    email: string;
    fullName: string;
    roles: string[];
    locationId?: string | null;
  }) {
    const jti = randomUUID();
    const locationId = user.locationId ?? null;
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
      { ...base, typ: 'access', jti },
      { secret: accessSecret, expiresIn: accessTtl as '15m' },
    );
    const stationToken = await this.jwt.signAsync(
      { ...base, typ: 'station', jti: randomUUID() },
      { secret: accessSecret, expiresIn: stationTtl as '12h' },
    );
    const refreshToken = await this.jwt.signAsync(
      { ...base, typ: 'refresh', jti },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtl as '7d',
      },
    );

    await this.prisma.user.update({
      where: { id: user.userId },
      data: {
        refreshTokenHash: createHash('sha256')
          .update(refreshToken)
          .digest('hex'),
        refreshTokenExpiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });

    return { accessToken, stationToken, refreshToken };
  }

  /**
   * After classic register-tenant: ensure identity + membership exist.
   */
  async ensureAfterTenantRegister(args: {
    email: string;
    fullName: string;
    phone?: string | null;
    passwordHash: string;
    tenantId: string;
    userId: string;
  }) {
    const email = args.email.trim().toLowerCase();
    let identity = await this.prisma.identityAccount.findUnique({
      where: { email },
    });
    if (!identity) {
      identity = await this.prisma.identityAccount.create({
        data: {
          email,
          fullName: args.fullName,
          phone: args.phone ?? undefined,
          passwordHash: args.passwordHash,
        },
      });
    }
    await this.linkUser(identity.id, args.tenantId, args.userId);
    return identity;
  }
}
