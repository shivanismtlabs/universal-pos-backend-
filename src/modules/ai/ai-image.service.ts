import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GenerateProductImageDto } from './dto/ai-image.dto';

const DEFAULT_BASE = 'https://image.pollinations.ai/prompt';
const MAX_BYTES = 4 * 1024 * 1024;

@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Free Pollinations image endpoint (no key required for image.pollinations.ai).
   * Optional POLLINATIONS_API_KEY improves reliability / removes logo when supported.
   */
  async generateProductImage(dto: GenerateProductImageDto) {
    const name = dto.name.trim();
    if (name.length < 2) {
      throw new BadRequestException('Product name is required');
    }

    const hint = dto.hint?.trim();
    const prompt = [
      'Professional product photography for a retail catalog',
      `product: ${name}`,
      hint ? `details: ${hint}` : null,
      'clean white or soft studio background',
      'centered product, sharp focus, no text overlay, no watermark, no logo',
      'e-commerce listing style',
    ]
      .filter(Boolean)
      .join(', ');

    const base =
      this.config.get<string>('POLLINATIONS_IMAGE_BASE')?.trim() || DEFAULT_BASE;
    const width = Number(this.config.get('POLLINATIONS_WIDTH') ?? 768) || 768;
    const height = Number(this.config.get('POLLINATIONS_HEIGHT') ?? 768) || 768;
    const model =
      this.config.get<string>('POLLINATIONS_MODEL')?.trim() || 'flux';
    const apiKey = this.config.get<string>('POLLINATIONS_API_KEY')?.trim();

    const qs = new URLSearchParams({
      width: String(Math.min(1024, Math.max(256, width))),
      height: String(Math.min(1024, Math.max(256, height))),
      model,
      nologo: 'true',
      enhance: 'true',
      // bump seed so re-clicks get variety
      seed: String(Math.floor(Math.random() * 1_000_000_000)),
    });
    if (apiKey) qs.set('key', apiKey);

    const url = `${base.replace(/\/$/, '')}/${encodeURIComponent(prompt)}?${qs}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'image/*',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      this.logger.warn(
        `Pollinations fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ServiceUnavailableException(
        'AI image service is unavailable. Try again or upload a photo.',
      );
    }

    if (!res.ok) {
      this.logger.warn(`Pollinations HTTP ${res.status} for prompt len=${prompt.length}`);
      throw new ServiceUnavailableException(
        res.status === 429
          ? 'AI image limit reached — wait a moment or upload a photo.'
          : 'Could not generate image. Try again or upload a photo.',
      );
    }

    const contentType = (res.headers.get('content-type') || 'image/jpeg')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new ServiceUnavailableException(
        'AI returned a non-image response. Try again.',
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) {
      throw new BadRequestException(
        'Generated image was empty or too large. Try again.',
      );
    }

    const mime =
      contentType === 'image/png' ||
      contentType === 'image/webp' ||
      contentType === 'image/gif' ||
      contentType === 'image/jpeg' ||
      contentType === 'image/jpg'
        ? contentType === 'image/jpg'
          ? 'image/jpeg'
          : contentType
        : 'image/jpeg';

    const imageBase64 = `data:${mime};base64,${buf.toString('base64')}`;

    return {
      provider: 'pollinations',
      prompt,
      mime,
      bytes: buf.length,
      imageBase64,
    };
  }
}
