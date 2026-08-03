import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/** Offline queue sync — FR-OFF */
@Module({
  imports: [PaymentsModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
