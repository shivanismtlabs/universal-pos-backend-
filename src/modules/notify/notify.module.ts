import { Module } from '@nestjs/common';
import { GupshupWhatsAppProvider } from './gupshup.provider';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';

/** WhatsApp via Gupshup BSP — FR-MKT / BR-09 */
@Module({
  controllers: [NotifyController],
  providers: [NotifyService, GupshupWhatsAppProvider],
  exports: [NotifyService],
})
export class NotifyModule {}
