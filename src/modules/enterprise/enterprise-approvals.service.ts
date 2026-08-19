import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasPermission } from '../../common/rbac';
import { writeAudit } from '../../common/audit-write';
import { PrismaService } from '../../database/database.module';
import { ensureBusinessGroupForIdentity } from '../../common/ensure-business-group';
import type { AuthUser } from '../auth/types';
import { NotificationEngineService } from '../notify/notification-engine.service';

type PolicyConfig = {
  cashierMaxAmount?: number;
  managerMaxAmount?: number;
  cashierMaxPercent?: number;
  managerMaxPercent?: number;
  requireApproval?: boolean;
  steps?: Array<{ role: string }>;
};

export type ApprovalEval = {
  needsApproval: boolean;
  allowed: boolean;
  reason?: string;
  policy?: PolicyConfig;
};

@Injectable()
export class EnterpriseApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationEngineService,
  ) {}

  async evaluate(
    user: AuthUser | null | undefined,
    input: {
      type: string;
      tenantId: string;
      amount?: number;
      percent?: number;
      entityType: string;
      entityId?: string;
      reason?: string;
      payload?: unknown;
    },
  ): Promise<ApprovalEval> {
    if (!user) {
      return { needsApproval: false, allowed: true };
    }
    const policy = await this.loadPolicy(input.tenantId, input.type);
    if (!policy?.enabled) {
      return { needsApproval: false, allowed: true, policy: policy?.config };
    }
    const cfg = policy.config;
    const roles = user.roles ?? [];
    const isAdmin =
      roles.includes('admin') || hasPermission(user.permissions, '*');
    if (isAdmin) return { needsApproval: false, allowed: true, policy: cfg };

    if (input.type === 'discount' && input.percent != null) {
      const cashierCap = cfg.cashierMaxPercent ?? 5;
      const managerCap = cfg.managerMaxPercent ?? 15;
      if (roles.includes('cashier') && input.percent > cashierCap + 1e-6) {
        return {
          needsApproval: true,
          allowed: false,
          reason: `Discount ${input.percent.toFixed(1)}% exceeds cashier limit of ${cashierCap}%`,
          policy: cfg,
        };
      }
      if (roles.includes('manager') && input.percent > managerCap + 1e-6) {
        return {
          needsApproval: true,
          allowed: false,
          reason: `Discount ${input.percent.toFixed(1)}% exceeds manager limit of ${managerCap}%`,
          policy: cfg,
        };
      }
      return { needsApproval: false, allowed: true, policy: cfg };
    }

    if (input.amount != null) {
      const cashierCap = cfg.cashierMaxAmount;
      const managerCap = cfg.managerMaxAmount;
      if (
        roles.includes('cashier') &&
        cashierCap != null &&
        input.amount > cashierCap + 1e-6
      ) {
        return {
          needsApproval: true,
          allowed: false,
          reason: `Amount exceeds cashier limit of ${cashierCap}`,
          policy: cfg,
        };
      }
      if (
        roles.includes('manager') &&
        managerCap != null &&
        input.amount > managerCap + 1e-6
      ) {
        return {
          needsApproval: true,
          allowed: false,
          reason: `Amount exceeds manager limit of ${managerCap}`,
          policy: cfg,
        };
      }
    }

    if (
      cfg.requireApproval &&
      !roles.includes('manager') &&
      !roles.includes('inventory') &&
      !isAdmin
    ) {
      return {
        needsApproval: true,
        allowed: false,
        reason: 'Approval required by policy',
        policy: cfg,
      };
    }

    return { needsApproval: false, allowed: true, policy: cfg };
  }

  async assertOrQueue(
    user: AuthUser,
    input: {
      type: string;
      tenantId: string;
      amount?: number;
      percent?: number;
      entityType: string;
      entityId?: string;
      reason?: string;
      payload?: unknown;
    },
  ) {
    const evaled = await this.evaluate(user, input);
    if (evaled.allowed && !evaled.needsApproval) return { queued: false as const };
    const req = await this.createRequest(user, input);
    throw new ForbiddenException({
      message: evaled.reason ?? 'Approval required',
      approvalRequestId: req.id,
      status: 'pending',
    });
  }

  async createRequest(
    user: AuthUser,
    input: {
      type: string;
      tenantId: string;
      amount?: number;
      percent?: number;
      entityType: string;
      entityId?: string;
      reason?: string;
      payload?: unknown;
    },
  ) {
    const groupId = await this.groupIdForTenant(input.tenantId, user);
    const policy = await this.loadPolicy(input.tenantId, input.type);
    const steps = policy?.config.steps?.length
      ? policy.config.steps
      : [{ role: 'manager' }];
    const row = await this.prisma.approvalRequest.create({
      data: {
        businessGroupId: groupId,
        tenantId: input.tenantId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        requestedById: user.userId,
        amount: input.amount,
        reason: input.reason,
        status: 'pending',
        currentStep: 0,
        payload: (input.payload ?? {}) as object,
        steps: {
          create: steps.map((s, i) => ({
            stepIndex: i,
            status: i === 0 ? 'pending' : 'pending',
            note: s.role,
          })),
        },
      },
    });
    await writeAudit(this.prisma, {
      tenantId: input.tenantId,
      actorUserId: user.userId,
      entityType: 'approval_request',
      entityId: row.id,
      action: `approval.request.${input.type}`,
      after: { type: input.type, amount: input.amount, percent: input.percent },
      reason: input.reason,
    });
    void this.notify.emit({
      tenantId: input.tenantId,
      type: 'inventory_alert',
      title: `Approval needed: ${input.type}`,
      body: input.reason || `${input.type} awaiting approval`,
      severity: 'critical',
      href: '/group/approvals',
      recipientRoles: ['manager', 'admin'],
      payload: { approvalRequestId: row.id, type: input.type },
    });
    return row;
  }

  async list(tenantId: string, status?: string) {
    return this.prisma.approvalRequest.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
      },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async listGroup(groupId: string, status?: string) {
    return this.prisma.approvalRequest.findMany({
      where: {
        businessGroupId: groupId,
        ...(status ? { status } : {}),
      },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async decide(
    user: AuthUser,
    requestId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ) {
    const row = await this.prisma.approvalRequest.findFirst({
      where: { id: requestId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Approval request not found');
    if (row.tenantId !== user.tenantId && !hasPermission(user.permissions, '*')) {
      throw new ForbiddenException('Cannot decide another business’s request');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('Request is not pending');
    }
    const can =
      user.roles.includes('admin') ||
      user.roles.includes('manager') ||
      hasPermission(user.permissions, `${row.type}.approve`) ||
      hasPermission(user.permissions, 'refund.approve') ||
      hasPermission(user.permissions, '*');
    if (!can) throw new ForbiddenException('Not an approver');

    const step = row.steps[row.currentStep] ?? row.steps[0];
    await this.prisma.$transaction(async (tx) => {
      if (step) {
        await tx.approvalStep.update({
          where: { id: step.id },
          data: {
            status: decision,
            actorId: user.userId,
            note,
            actedAt: new Date(),
          },
        });
      }
      const last = row.currentStep >= row.steps.length - 1 || decision === 'rejected';
      await tx.approvalRequest.update({
        where: { id: row.id },
        data: {
          status: decision === 'rejected' ? 'rejected' : last ? 'approved' : 'pending',
          currentStep: last ? row.currentStep : row.currentStep + 1,
          resolvedById: last ? user.userId : undefined,
          resolvedAt: last ? new Date() : undefined,
        },
      });
    });
    await writeAudit(this.prisma, {
      tenantId: row.tenantId,
      actorUserId: user.userId,
      entityType: 'approval_request',
      entityId: row.id,
      action: `approval.${decision}.${row.type}`,
      before: { status: 'pending' },
      after: { status: decision, note },
      reason: note,
      approvedBy: user.userId,
    });
    return this.prisma.approvalRequest.findUnique({
      where: { id: row.id },
      include: { steps: true },
    });
  }

  async policies(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { businessGroupId: true },
    });
    if (!tenant?.businessGroupId) return [];
    return this.prisma.approvalPolicy.findMany({
      where: {
        businessGroupId: tenant.businessGroupId,
        OR: [{ tenantId: null }, { tenantId }],
      },
      orderBy: { type: 'asc' },
    });
  }

  async updatePolicy(
    user: AuthUser,
    policyId: string,
    config: PolicyConfig,
    enabled?: boolean,
  ) {
    if (
      !user.roles.includes('admin') &&
      !hasPermission(user.permissions, '*')
    ) {
      throw new ForbiddenException('Only admin can change approval policies');
    }
    const existing = await this.prisma.approvalPolicy.findFirst({
      where: { id: policyId },
    });
    if (!existing) throw new NotFoundException('Policy not found');
    const updated = await this.prisma.approvalPolicy.update({
      where: { id: policyId },
      data: {
        config: config as object,
        ...(enabled !== undefined ? { enabled } : {}),
      },
    });
    await writeAudit(this.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.userId,
      entityType: 'approval_policy',
      entityId: policyId,
      action: 'approval.policy.update',
      before: existing.config,
      after: updated.config,
    });
    return updated;
  }

  private async loadPolicy(tenantId: string, type: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { businessGroupId: true },
    });
    if (!tenant?.businessGroupId) return null;
    const row = await this.prisma.approvalPolicy.findFirst({
      where: {
        businessGroupId: tenant.businessGroupId,
        type,
        enabled: true,
        OR: [{ tenantId }, { tenantId: null }],
      },
      orderBy: { tenantId: 'desc' },
    });
    if (!row) return null;
    return {
      enabled: row.enabled,
      config: (row.config ?? {}) as PolicyConfig,
    };
  }

  private async groupIdForTenant(tenantId: string, user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { businessGroupId: true },
    });
    if (tenant?.businessGroupId) return tenant.businessGroupId;
    const link = await this.prisma.identityTenantMembership.findFirst({
      where: { userId: user.userId },
    });
    if (link) {
      const g = await ensureBusinessGroupForIdentity(this.prisma, link.identityId);
      if (g?.id) return g.id;
    }
    throw new BadRequestException('Business is not in a group yet');
  }
}
