import { Module } from '@nestjs/common';
import { GupshupWhatsAppProvider } from './gupshup.provider';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { NotificationEngineService } from './notification-engine.service';
import { LowStockAlertService } from './low-stock-alert.service';
import { FirebasePushService } from './firebase-push.service';

/** Notifications — outbound (WA/SMS/email) + in-app engine + FCM push */
@Module({
  controllers: [NotifyController],
  providers: [
    NotifyService,
    GupshupWhatsAppProvider,
    FirebasePushService,
    NotificationEngineService,
    LowStockAlertService,
  ],
  exports: [
    NotifyService,
    NotificationEngineService,
    LowStockAlertService,
    FirebasePushService,
  ],
})
export class NotifyModule {}
