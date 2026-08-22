import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CommerceModeGuard } from '../../common/guards/commerce-mode.guard';
import { PosService } from './pos.service';
import type { AuthUser } from '../auth/types';

describe('CSV Catalog Import Authorization & Commerce Mode Guard', () => {
  let guard: CommerceModeGuard;
  let reflector: Reflector;
  let mockPrisma: any;

  beforeEach(() => {
    reflector = new Reflector();
    mockPrisma = {
      tenant: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      location: {
        findFirst: jest.fn(),
      },
      category: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      product: {
        create: jest.fn(),
      },
      stockLevel: {
        create: jest.fn(),
      },
    };
    guard = new CommerceModeGuard(reflector, mockPrisma as any);
  });

  function mockContext(handlerModes: string[], tenantSettings: any, tenantId = 'tenant-123') {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(handlerModes);
    mockPrisma.tenant.findUnique.mockResolvedValue({ settings: tenantSettings });
    mockPrisma.tenant.findUniqueOrThrow.mockResolvedValue({ settings: tenantSettings });

    const getRequest = jest.fn().mockReturnValue({
      user: { tenantId, userId: 'user-123' },
    });

    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest }),
    } as unknown as ExecutionContext;
  }

  describe('CommerceModeGuard (ANY-of semantics)', () => {
    it('allows CSV import for sale-only shop', async () => {
      const ctx = mockContext(
        ['sale', 'service', 'rental', 'subscription'],
        { commerceModes: ['sale'] },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows CSV import for Gym shop (subscription + service) without sale mode', async () => {
      const ctx = mockContext(
        ['sale', 'service', 'rental', 'subscription'],
        { commerceModes: ['subscription', 'service'] },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows CSV import for service-only shop', async () => {
      const ctx = mockContext(
        ['sale', 'service', 'rental', 'subscription'],
        { commerceModes: ['service'] },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('blocks CSV import if shop has no commerce modes configured', async () => {
      const ctx = mockContext(
        ['sale', 'service', 'rental', 'subscription'],
        { commerceModes: [] },
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(BadRequestException);
    });

    it('STRICTLY REJECTS retail sale POS checkout for Gym shop lacking sale mode', async () => {
      const ctx = mockContext(
        ['sale'], // Retail POS checkout specifies ['sale'] ONLY
        { commerceModes: ['subscription', 'service'] },
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('PosService.importSaleProducts catalog shop assertion', () => {
    let service: PosService;

    beforeEach(() => {
      service = new PosService(
        mockPrisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('allows Gym shop without sale mode to import products and services', async () => {
      const user: AuthUser = {
        tenantId: 'gym-tenant',
        userId: 'user-1',
        email: 'owner@gym.demo',
        fullName: 'Gym Owner',
        roles: ['admin'],
      };

      mockPrisma.tenant.findUniqueOrThrow.mockResolvedValue({
        settings: { commerceModes: ['subscription', 'service'] },
      });
      mockPrisma.location.findFirst.mockResolvedValue({ id: 'loc-1' });
      mockPrisma.category.findFirst.mockResolvedValue({ id: 'cat-1', name: 'General' });

      // Mock addSaleProduct internal calls
      jest.spyOn(service, 'addSaleProduct').mockResolvedValue({
        product: { id: 'p-1', title: 'Day Pass', sku: 'GYM-DP-01' },
        stockLevel: { id: 'sl-1' },
      } as any);

      const res = await service.importSaleProducts(user, {
        items: [
          { title: 'Day Pass', sku: 'GYM-DP-01', price: 500, trackInventory: false, sellUnit: 'service' as any },
          { title: 'Towel', sku: 'GYM-TWL-01', price: 150, qty: 10, trackInventory: true, sellUnit: 'pcs' as any },
        ],
      });

      expect(res.imported).toBe(2);
      expect(res.created).toHaveLength(2);
    });

    it('rejects import if shop is uninitialized / missing commerce modes', async () => {
      const user: AuthUser = {
        tenantId: 'uninit-tenant',
        userId: 'user-1',
        email: 'user@shop.demo',
        fullName: 'Shop User',
        roles: ['admin'],
      };

      mockPrisma.tenant.findUniqueOrThrow.mockResolvedValue({
        settings: { commerceModes: [] },
      });

      await expect(
        service.importSaleProducts(user, {
          items: [{ title: 'Item', sku: 'SKU1', price: 10 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
