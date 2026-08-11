import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { IamModule } from './modules/iam/iam.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { NotifyModule } from './modules/notify/notify.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlatformBillingModule } from './modules/platform-billing/platform-billing.module';
import { PosModule } from './modules/pos/pos.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { SyncModule } from './modules/sync/sync.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

const enableQueues = process.env.ENABLE_QUEUES === 'true';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    ...(enableQueues ? [QueueModule] : []),
    StorageModule,
    HealthModule,
    AuthModule,
    TenantsModule,
    UsersModule,
    AppsModule,
    CustomersModule,
    InventoryModule,
    OrdersModule,
    PaymentsModule,
    BillingModule,
    PlatformBillingModule,
    DocumentsModule,
    AppointmentsModule,
    SuppliersModule,
    SyncModule,
    PosModule,
    SubscriptionsModule,
    ReturnsModule,
    ReportsModule,
    NotifyModule,
    ExpensesModule,
    LoyaltyModule,
    IamModule,
  ],
})
export class AppModule {}
