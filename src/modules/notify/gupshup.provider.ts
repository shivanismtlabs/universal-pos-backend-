import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type GupshupSendResult = {
  mode: 'live' | 'mock';
  providerMessageId?: string;
  raw?: unknown;
};

@Injectable()
export class GupshupWhatsAppProvider {
  private readonly logger = new Logger(GupshupWhatsAppProvider.name);

  constructor(private readonly config: ConfigService) {}

  getStatus() {
    const bsp = (this.config.get<string>('WHATSAPP_BSP') ?? 'gupshup').trim();
    const apiKey = this.config.get<string>('WHATSAPP_API_KEY')?.trim() ?? '';
    const source = this.normalizePhone(
      this.config.get<string>('WHATSAPP_SOURCE_NUMBER') ?? '',
    );
    const appName =
      this.config.get<string>('WHATSAPP_APP_NAME')?.trim() || 'UniversalPOS';
    const mockForced =
      (this.config.get<string>('WHATSAPP_MOCK') ?? '').toLowerCase() === 'true';
    const configured = Boolean(apiKey && source);
    const mock = mockForced || !configured;

    return {
      bsp,
      configured,
      mock,
      source: source || null,
      appName,
      ready: configured || mock,
    };
  }

  normalizePhone(input: string): string {
    const digits = input.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `91${digits}`;
    if (digits.startsWith('0') && digits.length === 11) {
      return `91${digits.slice(1)}`;
    }
    return digits;
  }

  async sendText(destinationRaw: string, text: string): Promise<GupshupSendResult> {
    const status = this.getStatus();
    const destination = this.normalizePhone(destinationRaw);
    if (!destination || destination.length < 10) {
      throw new ServiceUnavailableException('Invalid destination phone number');
    }
    if (!text.trim()) {
      throw new ServiceUnavailableException('Message text is empty');
    }

    if (status.mock) {
      const providerMessageId = `mock_${Date.now()}`;
      this.logger.log(
        `[MOCK WhatsApp] to=${destination} text=${text.slice(0, 120)}`,
      );
      return { mode: 'mock', providerMessageId };
    }

    const apiKey = this.config.get<string>('WHATSAPP_API_KEY')!.trim();
    const source = status.source!;
    const appName = status.appName;

    const body = new URLSearchParams();
    body.set('channel', 'whatsapp');
    body.set('source', source);
    body.set('destination', destination);
    body.set('src.name', appName);
    body.set(
      'message',
      JSON.stringify({
        type: 'text',
        text,
      }),
    );

    const res = await fetch('https://api.gupshup.io/sm/api/v1/msg', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const rawText = await res.text();
    let raw: unknown = rawText;
    try {
      raw = JSON.parse(rawText);
    } catch {
      /* keep text */
    }

    if (!res.ok) {
      this.logger.error(`Gupshup error ${res.status}: ${rawText}`);
      throw new ServiceUnavailableException(
        typeof raw === 'object' &&
          raw &&
          'message' in raw &&
          typeof (raw as { message: unknown }).message === 'string'
          ? (raw as { message: string }).message
          : `Gupshup send failed (${res.status})`,
      );
    }

    const providerMessageId =
      typeof raw === 'object' &&
      raw &&
      'messageId' in raw &&
      typeof (raw as { messageId: unknown }).messageId === 'string'
        ? (raw as { messageId: string }).messageId
        : undefined;

    return { mode: 'live', providerMessageId, raw };
  }
}
