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
    const raw = [
      this.config.get<string>('WEBAUTHN_ORIGIN'),
      this.config.get<string>('PUBLIC_APP_URL'),
      this.config.get<string>('FRONTEND_URL'),
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]
      .filter(Boolean)
      .join(',');
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
   * Live apps serve FE from several hosts (localhost, 127.0.0.1, prod HTTPS/IP).
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
          const clientUrl = new URL(normalizedClient);
          const clientHost = clientUrl.hostname;
          const hostMatch = allowed.find((o) => {
            try {
              return new URL(o).hostname === clientHost;
            } catch {
              return false;
            }
          });
          const loopback =
            clientHost === 'localhost' || clientHost === '127.0.0.1';
          const rpMatch =
            Boolean(envRp) &&
            (clientHost === envRp || clientHost.endsWith(`.${envRp}`));
          // Accept browser origin when host is known / loopback / matches RP ID,
          // or when the FE explicitly sent clientOrigin (trusted after login CORS).
          if (hostMatch || loopback || rpMatch) {
            origin = normalizedClient;
          } else if (clientUrl.protocol === 'https:' || loopback) {
            // Prefer live browser origin over stale env default so prod HTTPS works
            // even if WEBAUTHN_ORIGIN was not updated yet.
            origin = normalizedClient;
            this.log.warn(
              `WebAuthn accepting unlisted origin ${normalizedClient} (add it to WEBAUTHN_ORIGIN)`,
            );
          } else if (
            clientUrl.protocol === 'http:' &&
            (/^\d+\.\d+\.\d+\.\d+$/.test(clientHost) || clientHost.includes('.'))
          ) {
            // HTTP IP / LAN host — still resolve RP ID correctly; browser may block
            // WebAuthn until HTTPS, but verify must use the same origin the page has.
            origin = normalizedClient;
            this.log.warn(
              `WebAuthn using HTTP origin ${normalizedClient} — browsers require HTTPS (or localhost) for biometrics`,
            );
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

    // RP ID = registrable domain / exact host. Never use "localhost" for an IP host.
    let rpID = host;
    if (envRp) {
      if (
        host === envRp ||
        host.endsWith(`.${envRp}`) ||
        (envRp === 'localhost' &&
          (host === 'localhost' || host === '127.0.0.1'))
      ) {
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

  /** Origins accepted during verify (client + configured list). */
  private expectedOrigins(primary: string): string | string[] {
    const set = new Set<string>([primary, ...this.configuredOrigins()]);
    try {
      const u = new URL(primary);
      if (u.hostname === 'localhost') {
        set.add(`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`);
      } else if (u.hostname === '127.0.0.1') {
        set.add(`${u.protocol}//localhost${u.port ? `:${u.port}` : ''}`);
      }
    } catch {
      /* ignore */
    }
    const list = [...set];
    return list.length === 1 ? list[0]! : list;
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
        transports: (c.transports?.length
          ? c.transports
          : ['internal']) as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        // Fingerprint / Windows Hello / Touch ID / Face ID
        authenticatorAttachment: 'platform',
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
    if (!body || typeof body !== 'object' || !body.id) {
      throw new BadRequestException(
        'Missing biometric response — complete the fingerprint / Windows Hello prompt',
      );
    }
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
        expectedOrigin: this.expectedOrigins(origin),
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
          : 'Biometric registration failed — use the same address bar host (localhost vs 127.0.0.1), HTTPS or localhost, and retry',
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Biometric registration not verified');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    const transports =
      body.response.transports?.length
        ? body.response.transports
        : (['internal'] as AuthenticatorTransportFuture[]);

    await this.prisma.webAuthnCredential.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports,
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
        transports: (c.transports?.length
          ? c.transports
          : ['internal']) as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });

    // Challenge is keyed by email so multi-tenant same-email still works
    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: creds[0]!.userId,
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
    if (!body || typeof body !== 'object' || !body.id) {
      throw new UnauthorizedException(
        'Missing biometric response — complete the fingerprint / Windows Hello prompt',
      );
    }
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
        expectedOrigin: this.expectedOrigins(origin),
        expectedRPID: rpID,
        // Options use userVerification: 'preferred' — do not hard-require UV
        // (Windows Hello often returns without UV when PIN/face is skipped).
        requireUserVerification: false,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: Number(cred.counter),
          transports: (cred.transports?.length
            ? cred.transports
            : ['internal']) as AuthenticatorTransportFuture[],
        },
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log.warn(
        `WebAuthn auth verify failed (origin=${origin} rpID=${rpID}): ${detail}`,
      );
      throw new UnauthorizedException(
        detail.includes('User verification')
          ? 'Biometric verification failed — complete Windows Hello / fingerprint prompt'
          : detail.includes('origin') || detail.includes('RP ID')
            ? 'Biometric verification failed — open the same site host you used when registering (localhost vs 127.0.0.1), then re-register if needed'
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
