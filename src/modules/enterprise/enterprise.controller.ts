import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { EnterpriseAuthGuard } from './enterprise-auth.guard';
import { CurrentEnterprise } from './enterprise-principal.decorator';
import { EnterpriseAlertsService } from './enterprise-alerts.service';
import { EnterpriseApprovalsService } from './enterprise-approvals.service';
import { EnterpriseGroupService } from './enterprise-group.service';
import { EnterpriseInventoryService } from './enterprise-inventory.service';
import { EnterpriseMetricsService } from './enterprise-metrics.service';
import type { EnterprisePrincipal } from './enterprise.types';
import { canSeeGroupAudit, canSeeGroupFinance } from './enterprise.types';
import { PrismaService } from '../../database/database.module';

@ApiTags('enterprise')
@ApiBearerAuth()
@Public()
@UseGuards(EnterpriseAuthGuard)
@Controller('enterprise')
export class EnterpriseController {
  constructor(
    private readonly groups: EnterpriseGroupService,
    private readonly metrics: EnterpriseMetricsService,
    private readonly inventory: EnterpriseInventoryService,
    private readonly approvals: EnterpriseApprovalsService,
    private readonly alerts: EnterpriseAlertsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('group')
  @ApiOperation({ summary: 'All Businesses list + group metadata' })
  overview(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.groups.overview(p);
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'All Businesses KPI dashboard (live aggregates)' })
  dashboard(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query() query: Record<string, string>,
  ) {
    return this.metrics.dashboard(p, query);
  }

  @Get('pnl')
  @ApiOperation({ summary: 'Consolidated P&L rollup (not a merged legal book)' })
  pnl(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query() query: Record<string, string>,
  ) {
    return this.metrics.groupPnl(p, query);
  }

  @Get('comparison')
  @ApiOperation({ summary: 'Business profit comparison' })
  comparison(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query() query: Record<string, string>,
  ) {
    return this.metrics.comparison(p, query);
  }

  @Get('orders/:tenantId')
  @ApiOperation({ summary: 'Drill-down: orders for a business' })
  drill(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: Record<string, string>,
  ) {
    return this.metrics.drillOrders(p, tenantId, {
      ...query,
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 25,
    });
  }

  @Get('inventory')
  @ApiOperation({ summary: 'Cross-business inventory map (location-owned)' })
  inventoryMap(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query('q') q: string,
  ) {
    return this.inventory.map(p, q);
  }

  @Get('intercompany')
  listIc(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.inventory.list(p);
  }

  @Post('intercompany')
  createIc(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Body()
    body: {
      sourceTenantId: string;
      destinationTenantId: string;
      sourceLocationId: string;
      destinationLocationId: string;
      notes?: string;
      lines: Array<{ sku: string; quantity: number; unitCost?: number }>;
    },
  ) {
    return this.inventory.createTransfer(p, body);
  }

  @Post('intercompany/:id/issue')
  issueIc(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventory.issue(p, id);
  }

  @Post('intercompany/:id/receive')
  receiveIc(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventory.receive(p, id);
  }

  @Get('approvals')
  async approvalsList(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query('status') status?: string,
  ) {
    const visible =
      p.groupRole === 'owner' ||
      p.groupRole === 'finance' ||
      p.groupRole === 'auditor'
        ? await this.groups.allTenantIdsInGroup(p.groupId)
        : p.tenantIds;
    return this.approvals.listGroup(p.groupId, status, visible);
  }

  @Post('approvals/:id/decide')
  decide(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { decision: 'approved' | 'rejected'; note?: string },
  ) {
    if (!user) {
      throw new ForbiddenException('Enter a shop session to approve');
    }
    return this.approvals.decide(user, id, body.decision, body.note);
  }

  @Get('policies')
  policies(@CurrentEnterprise() p: EnterprisePrincipal, @CurrentUser() user: AuthUser) {
    const tenantId = user?.tenantId ?? p.tenantIds[0];
    if (!tenantId) return [];
    return this.approvals.policies(tenantId);
  }

  @Patch('policies/:id')
  updatePolicy(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { config: Record<string, unknown>; enabled?: boolean },
  ) {
    if (!user) throw new ForbiddenException('Shop session required');
    return this.approvals.updatePolicy(user, id, body.config, body.enabled);
  }

  @Get('alerts/rules')
  alertRules(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.alerts.listRules(p.groupId);
  }

  @Patch('alerts/rules/:id')
  updateAlert(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: { enabled?: boolean; threshold?: number; cooldownMinutes?: number },
  ) {
    return this.alerts.updateRule(p.groupId, id, body);
  }

  @Post('alerts/evaluate')
  evaluateAlerts(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.alerts.evaluateGroup(p.groupId);
  }

  @Get('staff')
  staff(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.groups.staffProfile(p);
  }

  @Get('customers')
  customers(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query('q') q?: string,
  ) {
    return this.groups.groupCustomers(p, q);
  }

  @Get('suppliers')
  suppliers(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query('q') q?: string,
  ) {
    return this.groups.groupSuppliers(p, q);
  }

  @Get('procurement')
  procurement(@CurrentEnterprise() p: EnterprisePrincipal) {
    return this.groups.procurementSummary(p);
  }

  @Patch('businesses/:tenantId/share')
  share(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body()
    body: {
      shareInventory?: boolean;
      shareSuppliers?: boolean;
      shareCustomers?: boolean;
    },
  ) {
    return this.groups.setShare(p, tenantId, body);
  }

  @Post('spin-off')
  spinOff(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Body() body: { tenantId: string; confirmation: string },
  ) {
    return this.groups.startSpinOff(p, body.tenantId, body.confirmation);
  }

  @Post('spin-off/:id/complete')
  completeSpinOff(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.groups.completeSpinOff(p, id);
  }

  @Get('audit')
  async audit(
    @CurrentEnterprise() p: EnterprisePrincipal,
    @Query('q') q?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    if (!canSeeGroupAudit(p)) {
      throw new ForbiddenException('Audit access denied');
    }
    const ids = tenantId ? [tenantId] : await this.groups.allTenantIdsInGroup(p.groupId);
    return this.prisma.auditLog.findMany({
      where: {
        tenantId: { in: ids },
        ...(q
          ? {
              OR: [
                { action: { contains: q, mode: 'insensitive' } },
                { entityType: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('entitlements')
  entitlements(@CurrentEnterprise() p: EnterprisePrincipal) {
    return {
      role: p.groupRole,
      entitlements: p.entitlements,
      canFinance: canSeeGroupFinance(p),
      pricingModel: 'platform_plus_registers',
    };
  }
}
