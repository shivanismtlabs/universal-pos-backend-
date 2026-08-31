import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../../database/database.module';
import { MailService } from '../mail/mail.service';
import { isPrismaSchemaMismatch } from './auth-db-error';
import { assertPinAllowed } from './pin.policy';
import { AuthSessionService } from './auth-session.service';
import {
  isNonDeliverableEmail,
  shouldExposeDevOtp,
} from '../../common/cors-origins';

const BCRYPT_ROUNDS = 12;
const OTP_TTL_MS = 10 * 60_000;
const MAX_OTP_ATTEMPTS = 5;
const COOLDOWN_MS = 60_000;

export type OtpPurpose = 'password_reset' | 'pin_reset';

@Injectable()
export class AuthRecoveryService {
  private readonly log = new Logger(AuthRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly sessions: AuthSessionService,
  ) {}

  /**
   * Always returns generic success (no email enumeration).
   * In non-production (or AUTH_OTP_RETURN_CODE=1) includes devCode for QA.
   */
  async requestPasswordOtp(emailRaw: string) {
    const email = emailRaw.trim().toLowerCase();
    if (!email.includes('@')) {
      throw new BadRequestException('Enter a valid email');
    }
    await this.throttle(email, 'password_reset');

    let identity: { id: string; email: string } | null = null;
    try {
      identity = await this.prisma.identityAccount.findUnique({
        where: { email },
        select: { id: true, email: true },
      });
    } catch (e) {
      if (!isPrismaSchemaMismatch(e)) throw e;
    }
    const anyUser = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      select: { id: true },
    });

    let devCode: string | undefined;
    if (identity || anyUser) {
      devCode = await this.issueOtp({
        purpose: 'password_reset',
        email,
      });
    }

    return this.publicOtpResponse(email, devCode);
  }

  async resetPassword(params: {
    email: string;
    otp: string;
    newPassword: string;
  }) {
    const email = params.email.trim().toLowerCase();
    const otp = params.otp.trim();
    this.assertPasswordStrength(params.newPassword, email);
    await this.consumeOtp({
      purpose: 'password_reset',
      email,
      otp,
    });

    const passwordHash = await bcrypt.hash(params.newPassword, BCRYPT_ROUNDS);

    try {
      const identity = await this.prisma.identityAccount.findUnique({
        where: { email },
      });
      if (identity) {
        await this.prisma.identityAccount.update({
          where: { id: identity.id },
          data: {
            passwordHash,
            failedLoginAttempts: 0,
            lockedUntil: null,
            refreshTokenHash: null,
            refreshTokenExpiresAt: null,
          },
        });
      }
    } catch (e) {
      if (!isPrismaSchemaMismatch(e)) throw e;
    }

    await this.prisma.user.updateMany({
      where: { email },
      data: {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
      },
    });

    await this.sessions.revokeAllForEmail(email, 'PASSWORD_RESET');

    return { ok: true, message: 'Password updated. You can sign in now.' };
  }

  /** Request OTP to reset counter PIN for a staff user. */
  async requestPinOtp(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, email: true, fullName: true, tenantId: true },
    });
    if (!user?.email) {
      // Generic — don't reveal
      return this.publicOtpResponse('hidden@shop.local');
    }

    const email = user.email.trim().toLowerCase();
    await this.throttle(email, 'pin_reset');

    const devCode = await this.issueOtp({
      purpose: 'pin_reset',
      email,
      targetUserId: user.id,
    });

    return {
      ...this.publicOtpResponse(email, devCode),
      maskedEmail: this.maskEmail(email),
    };
  }

  async resetPin(params: { userId: string; otp: string; newPin: string }) {
    assertPinAllowed(params.newPin);
    const user = await this.prisma.user.findFirst({
      where: { id: params.userId, isActive: true },
      select: { id: true, email: true, tenantId: true },
    });
    if (!user?.email) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const email = user.email.trim().toLowerCase();
    await this.consumeOtp({
      purpose: 'pin_reset',
      email,
      otp: params.otp.trim(),
      targetUserId: user.id,
    });

    const pinHash = await bcrypt.hash(params.newPin, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        pinHash,
        pinSetAt: new Date(),
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.id,
        entityType: 'user',
        entityId: user.id,
        action: 'auth.pin_reset_otp',
        beforeAfter: { pinSet: true },
      },
    });

    return { ok: true, message: 'PIN updated. Unlock the counter with the new PIN.' };
  }

  private async issueOtp(args: {
    purpose: OtpPurpose;
    email: string;
    targetUserId?: string;
  }) {
    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await this.prisma.authOtpChallenge.create({
      data: {
        purpose: args.purpose,
        email: args.email,
        targetUserId: args.targetUserId,
        codeHash,
        expiresAt,
      },
    });

    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    if (isProd) {
      this.log.log(
        `OTP ${args.purpose} issued for ${this.maskEmail(args.email)}`,
      );
    } else {
      this.log.log(
        `OTP ${args.purpose} for ${args.email}: ${code} (expires ${expiresAt.toISOString()})`,
      );
    }

    const nonDeliverable = isNonDeliverableEmail(args.email);
    if (nonDeliverable) {
      this.log.warn(
        `Skipped SMTP for non-deliverable mailbox ${this.maskEmail(args.email)} — use on-screen / logged OTP`,
      );
    } else {
      try {
        const mailed = await this.mail.sendOtp({
          to: args.email,
          purpose: args.purpose,
          code,
          expiresMinutes: Math.round(OTP_TTL_MS / 60_000),
        });
        if (mailed) {
          this.log.log(`OTP email sent to ${this.maskEmail(args.email)}`);
        } else if (isProd) {
          this.log.error(
            'SMTP is not configured — OTP email was not sent. Set SMTP_HOST, SMTP_USER, SMTP_PASS.',
          );
        }
      } catch (e) {
        this.log.error(`OTP email failed: ${String(e)}`);
      }
    }

    const smtpHook = this.config.get<string>('AUTH_OTP_WEBHOOK_URL')?.trim();
    if (smtpHook) {
      try {
        await fetch(smtpHook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to: args.email,
            purpose: args.purpose,
            code,
            expiresAt: expiresAt.toISOString(),
          }),
        });
      } catch (e) {
        this.log.warn(`OTP webhook failed: ${String(e)}`);
      }
    }

    return code;
  }

  private async consumeOtp(args: {
    purpose: OtpPurpose;
    email: string;
    otp: string;
    targetUserId?: string;
  }) {
    const challenge = await this.prisma.authOtpChallenge.findFirst({
      where: {
        purpose: args.purpose,
        email: args.email,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        ...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    if (challenge.attemptCount >= MAX_OTP_ATTEMPTS) {
      throw new UnauthorizedException(
        'Too many incorrect codes. Request a new OTP.',
      );
    }

    const ok = await bcrypt.compare(args.otp, challenge.codeHash);
    if (!ok) {
      await this.prisma.authOtpChallenge.update({
        where: { id: challenge.id },
        data: { attemptCount: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    await this.prisma.authOtpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
  }

  private async throttle(email: string, purpose: OtpPurpose) {
    const recent = await this.prisma.authOtpChallenge.findFirst({
      where: {
        email,
        purpose,
        createdAt: { gt: new Date(Date.now() - COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      throw new BadRequestException(
        'Please wait a minute before requesting another code',
      );
    }
  }

  private publicOtpResponse(email: string, devCode?: string) {
    const nonDeliverable = isNonDeliverableEmail(email);
    const expose =
      nonDeliverable ||
      shouldExposeDevOtp({
        NODE_ENV: this.config.get<string>('NODE_ENV'),
        AUTH_OTP_RETURN_CODE: this.config.get<string>('AUTH_OTP_RETURN_CODE'),
      });

    const message = nonDeliverable
      ? 'Demo / test addresses cannot receive email. Use the on-screen OTP (valid 10 minutes).'
      : 'If an account exists for that email, a 6-digit OTP was sent. It is valid for 10 minutes.';

    return {
      ok: true as const,
      message,
      maskedEmail: this.maskEmail(email),
      ...(expose && devCode ? { devCode } : {}),
    };
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***';
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}***@${domain}`;
  }

  private assertPasswordStrength(password: string, email: string) {
    if (password.length < 8 || password.length > 72) {
      throw new BadRequestException('Password must be 8–72 characters');
    }
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      throw new BadRequestException(
        'Password needs upper, lower, and a number',
      );
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException('Password needs a special character');
    }
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 2 && password.toLowerCase().includes(local)) {
      throw new BadRequestException('Password must not contain email local-part');
    }
  }
}
