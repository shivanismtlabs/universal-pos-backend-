import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GenerateProductImageDto } from './dto/ai-image.dto';

const MAX_BYTES = 4 * 1024 * 1024;

@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Free Pollinations image generation.
   * Tries several URL shapes — production servers sometimes block one host.
   * Optional POLLINATIONS_API_KEY for gen.pollinations.ai.
   */
  async generateProductImage(dto: GenerateProductImageDto) {
    const name = dto.name.trim();
    if (name.length < 2) {
      throw new BadRequestException('Product name is required');
    }

    const hint = dto.hint?.trim();
    const prompt = this.buildPrompt(name, hint);
    const width = clampInt(this.config.get('POLLINATIONS_WIDTH'), 768, 256, 1024);
    const height = clampInt(this.config.get('POLLINATIONS_HEIGHT'), 768, 256, 1024);
    const model =
      this.config.get<string>('POLLINATIONS_MODEL')?.trim() || 'flux';
    const apiKey = this.config.get<string>('POLLINATIONS_API_KEY')?.trim();
    const customBase = this.config.get<string>('POLLINATIONS_IMAGE_BASE')?.trim();
    const seed = Math.floor(Math.random() * 1_000_000_000);

    const candidates = this.buildCandidateUrls({
      prompt,
      width,
      height,
      model,
      seed,
      apiKey,
      customBase,
    });

    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const result = await this.fetchImage(candidate.url, candidate.headers);
        if (result) {
          return {
            provider: 'pollinations',
            prompt,
            mime: result.mime,
            bytes: result.buf.length,
            imageBase64: `data:${result.mime};base64,${result.buf.toString('base64')}`,
            /** Public URL FE can retry if needed */
            sourceUrl: candidate.url.split('?')[0],
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${candidate.label}: ${msg}`);
        this.logger.warn(`Pollinations attempt failed (${candidate.label}): ${msg}`);
      }
    }

    this.logger.warn(`All Pollinations attempts failed: ${errors.join(' | ')}`);
    throw new ServiceUnavailableException(
      'AI image service is unavailable. Try again or upload a photo.',
    );
  }

  /** Public helper so FE can build the same prompt URL for browser fallback. */
  buildClientFallbackUrl(name: string, hint?: string) {
    const prompt = this.buildPrompt(name.trim(), hint?.trim());
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const qs = new URLSearchParams({
      width: '768',
      height: '768',
      model: 'flux',
      nologo: 'true',
      seed: String(seed),
    });
    return {
      prompt,
      url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${qs}`,
    };
  }

  private buildPrompt(name: string, hint?: string) {
    // Keep prompt shorter — long prompts timeout more often on free tier
    const parts = [
      'Product photo for online store',
      name.slice(0, 80),
      hint ? hint.slice(0, 100) : null,
      'white background, centered, sharp, no text',
    ].filter(Boolean);
    return parts.join(', ');
  }

  private buildCandidateUrls(opts: {
    prompt: string;
    width: number;
    height: number;
    model: string;
    seed: number;
    apiKey?: string;
    customBase?: string;
  }) {
    const enc = encodeURIComponent(opts.prompt);
    const qs = (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({
        width: String(opts.width),
        height: String(opts.height),
        model: opts.model,
        nologo: 'true',
        seed: String(opts.seed),
        ...extra,
      });
      if (opts.apiKey) p.set('key', opts.apiKey);
      return p.toString();
    };

    const authHeaders: Record<string, string> = {
      Accept: 'image/*,*/*',
      'User-Agent': 'UniversalPOS/1.0 (+https://upos.walit.in)',
    };
    if (opts.apiKey) {
      authHeaders.Authorization = `Bearer ${opts.apiKey}`;
    }

    const list: { label: string; url: string; headers: Record<string, string> }[] =
      [];

    if (opts.customBase) {
      list.push({
        label: 'custom-base',
        url: `${opts.customBase.replace(/\/$/, '')}/${enc}?${qs()}`,
        headers: authHeaders,
      });
    }

    // Primary free endpoint (no key)
    list.push({
      label: 'image.pollinations',
      url: `https://image.pollinations.ai/prompt/${enc}?${qs()}`,
      headers: authHeaders,
    });

    // Same host, turbo model (often faster / less queued)
    list.push({
      label: 'image.pollinations-turbo',
      url: `https://image.pollinations.ai/prompt/${enc}?${qs({ model: 'turbo' })}`,
      headers: authHeaders,
    });

    // Newer gateway (works better with API key; sometimes open)
    list.push({
      label: 'gen.pollinations',
      url: `https://gen.pollinations.ai/image/${enc}?${qs()}`,
      headers: authHeaders,
    });

    return list;
  }

  private async fetchImage(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ buf: Buffer; mime: string } | null> {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      // 45s per attempt — free tier can be slow
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    if (buf.length > MAX_BYTES) throw new Error(`too large (${buf.length})`);

    // Some gateways return HTML error pages with 200
    if (
      contentType.includes('text/html') ||
      (buf.length < 500 && buf.toString('utf8', 0, 64).includes('<html'))
    ) {
      throw new Error('HTML response (not an image)');
    }

    if (contentType.startsWith('image/')) {
      const mime =
        contentType === 'image/jpg' ? 'image/jpeg' : contentType;
      return { buf, mime };
    }

    // Sniff magic bytes when content-type is wrong/missing
    if (buf[0] === 0xff && buf[1] === 0xd8) return { buf, mime: 'image/jpeg' };
    if (buf[0] === 0x89 && buf[1] === 0x50) return { buf, mime: 'image/png' };
    if (buf[0] === 0x52 && buf[1] === 0x49) return { buf, mime: 'image/webp' };

    throw new Error(`unsupported content-type: ${contentType || 'none'}`);
  }
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
