import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import type { GenerateProductImageDto } from './dto/ai-image.dto';

const MAX_BYTES = 4 * 1024 * 1024;

@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Free Pollinations image generation.
   * Local Windows + antivirus SSL inspection often breaks Node's default
   * TLS verify (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). In non-production we
   * relax TLS for this outbound call only (override with POLLINATIONS_TLS_INSECURE).
   */
  async generateProductImage(dto: GenerateProductImageDto) {
    const name = dto.name.trim();
    if (name.length < 2) {
      throw new BadRequestException('Product name is required');
    }

    const hint = dto.hint?.trim();
    const prompt = this.buildPrompt(name, hint);
    const width = clampInt(this.config.get('POLLINATIONS_WIDTH'), 768, 256, 1024);
    const height = clampInt(
      this.config.get('POLLINATIONS_HEIGHT'),
      768,
      256,
      1024,
    );
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
        const result = await this.fetchImageHttps(
          candidate.url,
          candidate.headers,
        );
        return {
          provider: 'pollinations',
          prompt,
          mime: result.mime,
          bytes: result.buf.length,
          imageBase64: `data:${result.mime};base64,${result.buf.toString('base64')}`,
          sourceUrl: candidate.url.split('?')[0],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${candidate.label}: ${msg}`);
        this.logger.warn(
          `Pollinations attempt failed (${candidate.label}): ${msg}`,
        );
      }
    }

    this.logger.warn(`All Pollinations attempts failed: ${errors.join(' | ')}`);
    throw new ServiceUnavailableException(
      'AI image service is unavailable. Try again or upload a photo.',
    );
  }

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
    const parts = [
      'Product photo for online store',
      name.slice(0, 80),
      hint ? hint.slice(0, 100) : null,
      'white background, centered, sharp, no text',
    ].filter(Boolean);
    return parts.join(', ');
  }

  private tlsInsecure(): boolean {
    const flag = this.config.get<string>('POLLINATIONS_TLS_INSECURE')?.trim();
    if (flag === 'true' || flag === '1') return true;
    if (flag === 'false' || flag === '0') return false;
    return process.env.NODE_ENV !== 'production';
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
      'User-Agent': 'UniversalPOS/1.0',
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

    list.push({
      label: 'image.pollinations',
      url: `https://image.pollinations.ai/prompt/${enc}?${qs()}`,
      headers: authHeaders,
    });

    list.push({
      label: 'image.pollinations-turbo',
      url: `https://image.pollinations.ai/prompt/${enc}?${qs({ model: 'turbo' })}`,
      headers: authHeaders,
    });

    list.push({
      label: 'gen.pollinations',
      url: `https://gen.pollinations.ai/image/${enc}?${qs()}`,
      headers: authHeaders,
    });

    return list;
  }

  private fetchImageHttps(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ buf: Buffer; mime: string }> {
    const insecure = this.tlsInsecure();
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers,
          timeout: 60_000,
          rejectUnauthorized: !insecure,
        },
        (res) => {
          // Follow one redirect manually if needed
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const next = new URL(res.headers.location, url).toString();
            res.resume();
            this.fetchImageHttps(next, headers).then(resolve, reject);
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            try {
              resolve(
                this.parseImageBuffer(
                  res.statusCode ?? 0,
                  res.headers['content-type'] ?? null,
                  Buffer.concat(chunks),
                ),
              );
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  private parseImageBuffer(
    status: number,
    contentTypeHeader: string | null,
    buf: Buffer,
  ): { buf: Buffer; mime: string } {
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
    if (!buf.length) throw new Error('empty body');
    if (buf.length > MAX_BYTES) throw new Error(`too large (${buf.length})`);

    const contentType = (contentTypeHeader || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (
      contentType.includes('text/html') ||
      (buf.length < 500 && buf.toString('utf8', 0, 64).includes('<html'))
    ) {
      throw new Error('HTML response (not an image)');
    }

    if (contentType.startsWith('image/')) {
      const mime = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
      return { buf, mime };
    }

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
