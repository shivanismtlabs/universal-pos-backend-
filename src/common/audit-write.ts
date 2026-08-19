import type { Prisma } from '@prisma/client';

type AuditTx = {
  auditLog: {
    create: (args: {
      data: Prisma.AuditLogCreateInput | Prisma.AuditLogUncheckedCreateInput;
    }) => Promise<unknown>;
  };
};

/**
 * Money/stock/membership audit helper — old/new/why in beforeAfter JSON.
 */
export async function writeAudit(
  db: AuditTx,
  input: {
    tenantId: string;
    actorUserId?: string | null;
    entityType: string;
    entityId?: string | null;
    action: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    approvedBy?: string | null;
    ip?: string | null;
    device?: string | null;
    userAgent?: string | null;
  },
) {
  await db.auditLog.create({
    data: {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? undefined,
      entityType: input.entityType,
      entityId: input.entityId ?? undefined,
      action: input.action,
      ip: input.ip ?? undefined,
      device: input.device ?? undefined,
      userAgent: input.userAgent ?? undefined,
      beforeAfter: {
        old: input.before ?? null,
        new: input.after ?? null,
        reason: input.reason ?? null,
        approvedBy: input.approvedBy ?? null,
      } as Prisma.InputJsonValue,
    },
  });
}
