import { UnauthorizedException } from '@nestjs/common';
import { AuthSessionService } from './auth-session.service';

describe('AuthSessionService', () => {
  function serviceWith(prisma: Record<string, unknown>) {
    return new AuthSessionService(prisma as never);
  }

  it('assertActive rejects missing sessions', async () => {
    const svc = serviceWith({
      authSession: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc.assertActive('sid', 'user')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokeAllForUser marks sessions revoked and clears refresh hash', async () => {
    const updateMany = jest.fn();
    const userUpdate = jest.fn();
    const svc = serviceWith({
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      authSession: { updateMany },
      user: { update: userUpdate },
    });
    await svc.revokeAllForUser('u1', 'USER_DISABLED');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', revokedAt: null },
        data: expect.objectContaining({ revokeReason: 'USER_DISABLED' }),
      }),
    );
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
      }),
    );
  });
});
