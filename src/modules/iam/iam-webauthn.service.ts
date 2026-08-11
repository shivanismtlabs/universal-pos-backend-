import {
  BadRequestException,
  Injectable,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  private rpID() {
    return this.config.get<string>('WEBAUTHN_RP_ID') || 'localhost';
  }

  private rpName() {
    return this.config.get<string>('WEBAUTHN_RP_NAME') || 'Universal POS';
  }

  private origin() {
    return (
      this.config.get<string>('WEBAUTHN_ORIGIN') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:3000'
    );
  }

  async registrationOptions(user: AuthUser) {
    const existing = await this.prisma.webAuthnCredential.findMany({
      where: { userId: user.userId },
    });
    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpID(),
      userName: user.email,
      userDisplayName: user.fullName,
      userID: new TextEncoder().encode(user.userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform',
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

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: row.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpID(),
      });
    } catch {
      throw new BadRequestException('Biometric registration failed');
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
  async authenticationOptions(email: string) {
    const normalized = email.trim().toLowerCase();
    const dbUser = await this.prisma.user.findFirst({
      where: { email: normalized, isActive: true },
      include: { webAuthnCredentials: true },
    });
    if (!dbUser?.webAuthnCredentials.length) {
      throw new BadRequestException('No biometric credentials for this account');
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpID(),
      allowCredentials: dbUser.webAuthnCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });

    await this.prisma.webAuthnChallenge.create({
      data: {
        userId: dbUser.id,
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

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpID(),
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: Number(cred.counter),
          transports: cred.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      throw new UnauthorizedException('Biometric verification failed');
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
      where: { userId: cred.userId, type: 'authentication' },
    });

    // Reuse password-login path by issuing tokens
    return this.auth.issueSessionForUser(cred.userId);
  }
}
