import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

/**
 * Phase 2 — Identity & Organization only.
 * Commerce modules return in Phase 3 once adapters use the universal schema.
 */
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
  ],
})
export class AppModule {}
