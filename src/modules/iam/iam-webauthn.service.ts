import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { AuthService } from '../auth/auth.service';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class IamWebAuthnService {
  private readonly log = new Logger(IamWebAuthnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  private rpName() {
    return this.config.get<string>('WEBAUTHN_RP_NAME') || 'Universal POS';
  }

  /** Comma-separated allowed browser origins (scheme + host + port). */
  private configuredOrigins(): string[] {
    const raw =
      this.config.get<string>('WEBAUTHN_ORIGIN') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:3000';
    return [
      ...new Set(
        raw
          .split(/[,\s]+/)
          .map((s) => s.trim().replace(/\/$/, ''))
          .filter(Boolean),
      ),
    ];
  }

  /**
   * Live apps serve FE from several hosts (localhost, 127.0.0.1, prod HTTPS).
   * RP ID must match the browser host name used by the page origin.
   */
  private resolveRpContext(clientOrigin?: string | null): {
    rpID: string;
    origin: string;
  } {
    const allowed = this.configuredOrigins();
    const envRp = this.config.get<string>('WEBAUTHN_RP_ID')?.trim() || '';
    let origin = allowed[0] || 'http://localhost:3000';

    const normalizedClient = clientOrigin?.trim().replace(/\/$/, '') || '';
    if (normalizedClient) {
      if (allowed.includes(normalizedClient)) {
        origin = normalizedClient;
      } else {
        try {
          const clientHost = new URL(normalizedClient).hostname;
          const hostMatch = allowed.find((o) => {
            try {
              return new URL(o).hostname === clientHost;
            } catch {
              return false;
            }
          });
          // Accept exact client origin when host is known (port/scheme variants)
          if (hostMatch || clientHost === 'localhost' || clientHost === '127.0.0.1') {
            origin = normalizedClient;
          } else if (envRp && (clientHost === envRp || clientHost.endsWith(`.${envRp}`))) {
            origin = normalizedClient;
          }
        } catch {
          /* keep default */
        }
      }
    }

    let host = 'localhost';
    try {
      host = new URL(origin).hostname;
    } catch {
      /* default */
    }

    // Prefer explicit RP ID only when it is parent of or equal to current host
    let rpID = host;
    if (envRp) {
      if (
        host === envRp ||
        host.endsWith(`.${envRp}`) ||
        (envRp === 'localhost' && (host === 'localhost' || host === '127.0.0.1'))
      ) {
        // For 127.0.0.1 the browser RP ID must be 127.0.0.1, not "localhost"
        rpID =
          host === '127.0.0.1'
            ? '127.0.0.1'
            : envRp === 'localhost' && host === 'localhost'
              ? 'localhost'
              : host === envRp || host.endsWith(`.${envRp}`)
                ? envRp
                : host;
      }
    }

    return { rpID, origin };
  }

  async registrationOptions(user: AuthUser, clientOrigin?: string | null) {
    const { rpID } = this.resolveRpContext(clientOrigin);
    const existing = await this.prisma.webAuthnCredential.findMany({
      where: { userId: user.userId },
    });
    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID,
      userName: user.email,
      userDisplayName: user.fullName,
      userID: new TextEncoder().encode(user.userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        // Platform biometric (Windows Hello / Face ID / Touch ID) preferred;
        // omit attachment so USB keys still work on the same flow.
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: user.userId,
        challenge: options.challenge,
        type: 'registration',
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return options;
  }

  async registrationVerify(
    user: AuthUser,
    body: RegistrationResponseJSON,
    label?: string,
    clientOrigin?: string | null,
  ) {
    const row = await this.prisma.webAuthnChallenge.findFirst({
      where: {
        userId: user.userId,
        type: 'registration',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new BadRequestException('Challenge expired — try again');

    const { rpID, origin } = this.resolveRpContext(clientOrigin);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: row.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // Match authenticatorSelection.userVerification: 'preferred'
        requireUserVerification: false,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log.warn(
        `WebAuthn register verify failed (origin=${origin} rpID=${rpID}): ${detail}`,
      );
      throw new BadRequestException(
        detail.includes('User verification')
          ? 'Biometric registration failed — complete Windows Hello / passkey prompt, then try again'
          : 'Biometric registration failed — use HTTPS (or localhost), and ensure WEBAUTHN_ORIGIN matches this site',
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Biometric registration not verified');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    await this.prisma.webAuthnCredential.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: body.response.transports ?? [],
        label: label?.trim() || 'Device biometric',
      },
    });

    await this.prisma.webAuthnChallenge.deleteMany({
      where: { userId: user.userId, type: 'registration' },
    });

    return { ok: true, credentialId: credential.id };
  }

  async listCredentials(user: AuthUser) {
    return this.prisma.webAuthnCredential.findMany({
      where: { userId: user.userId },
      select: {
        id: true,
        label: true,
        deviceType: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  async deleteCredential(user: AuthUser, id: string) {
    await this.prisma.webAuthnCredential.deleteMany({
      where: { id, userId: user.userId },
    });
    return { ok: true };
  }

  /** Public: start biometric login for email (optional path). */
  async authenticationOptions(
    email: string,
    clientOrigin?: string | null,
  ) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('Email is required for biometric sign-in');
    }

    // All active staff with this email who registered a passkey
    const creds = await this.prisma.webAuthnCredential.findMany({
      where: {
        user: { email: normalized, isActive: true },
      },
      include: { user: { select: { id: true } } },
    });
    if (!creds.length) {
      throw new BadRequestException(
        'No biometric credentials for this account — register under Settings first',
      );
    }

    const { rpID } = this.resolveRpContext(clientOrigin);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });

    // Challenge is keyed by email so multi-tenant same-email still works
    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: creds[0].userId,
        email: normalized,
        challenge: options.challenge,
        type: 'authentication',
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    return options;
  }

  async authenticationVerify(
    email: string,
    body: AuthenticationResponseJSON,
    clientOrigin?: string | null,
  ) {
    const normalized = email.trim().toLowerCase();
    const challenge = await this.prisma.webAuthnChallenge.findFirst({
      where: {
        email: normalized,
        type: 'authentication',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw new UnauthorizedException('Challenge expired');

    const cred = await this.prisma.webAuthnCredential.findFirst({
      where: { credentialId: body.id },
      include: {
        user: {
          include: {
            tenant: true,
            userRoles: { include: { role: true } },
          },
        },
      },
    });
    if (!cred || cred.user.email !== normalized || !cred.user.isActive) {
      throw new UnauthorizedException('Invalid credential');
    }

    const { rpID, origin } = this.resolveRpContext(clientOrigin);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // Options use userVerification: 'preferred' — do not hard-require UV
        // (Windows Hello often returns without UV when PIN/face is skipped).
        requireUserVerification: false,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: Number(cred.counter),
          transports: cred.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log.warn(
        `WebAuthn auth verify failed (origin=${origin} rpID=${rpID}): ${detail}`,
      );
      throw new UnauthorizedException(
        detail.includes('User verification')
          ? 'Biometric verification failed — complete Windows Hello / passkey prompt'
          : detail.includes('origin') || detail.includes('RP ID')
            ? 'Biometric verification failed — origin/RP mismatch (re-register passkey on this site)'
            : 'Biometric verification failed — cancelled or credential not accepted',
      );
    }

    if (!verification.verified) {
      throw new UnauthorizedException('Biometric not verified');
    }

    await this.prisma.webAuthnCredential.update({
      where: { id: cred.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    await this.prisma.webAuthnChallenge.deleteMany({
      where: { email: normalized, type: 'authentication' },
    });

    return this.auth.issueSessionForUser(cred.userId);
  }
}
