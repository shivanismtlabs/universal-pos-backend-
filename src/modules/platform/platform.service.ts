import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async healthUsage() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [tenants, ordersToday, paymentsToday] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.rentalOrder.count({
        where: { createdAt: { gte: startOfDay } },
      }),
      this.prisma.payment.count({ where: { createdAt: { gte: startOfDay } } }),
    ]);

    return { tenants, ordersToday, paymentsToday, asOf: new Date() };
  }
}
