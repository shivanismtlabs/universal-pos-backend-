import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';

export type AuthRevokeReason =
  | 'LOGOUT'
  | 'PASSWORD_RESET'
  | 'USER_DISABLED'
  | 'ADMIN_REVOKED'
  | 'SECURITY_ACTION'
  | 'REFRESH_REUSE';

@Injectable()
export class AuthSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    userId: string;
    tenantId: string;
    expiresAt: Date;
    refreshTokenHash?: string | null;
  }) {
    return this.prisma.authSession.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        expiresAt: params.expiresAt,
        refreshTokenHash: params.refreshTokenHash ?? null,
      },
      select: { id: true },
    });
  }

  async assertActive(sessionId: string, userId: string) {
    const session = await this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) {
      throw new UnauthorizedException(
        'Access token expired. Please login again.',
      );
    }
    return session;
  }

  async setRefreshHash(
    sessionId: string,
    refreshTokenHash: string,
    expiresAt: Date,
  ) {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { refreshTokenHash, expiresAt },
    });
  }

  async findActiveForRefresh(sessionId: string, userId: string) {
    return this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  async revoke(sessionId: string, reason: AuthRevokeReason) {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: AuthRevokeReason) {
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
      }),
    ]);
  }

  async revokeAllForEmail(email: string, reason: AuthRevokeReason) {
    const users = await this.prisma.user.findMany({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });
    for (const u of users) {
      await this.revokeAllForUser(u.id, reason);
    }
  }
}
