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
    const width = clampInt(this.config.get('POLLINATIONS_WIDTH'), 1024, 256, 1024);
    const height = clampInt(
      this.config.get('POLLINATIONS_HEIGHT'),
      1024,
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
      width: '1024',
      height: '1024',
      model: 'flux',
      nologo: 'true',
      enhance: 'true',
      seed: String(seed),
    });
    return {
      prompt,
      url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${qs}`,
    };
  }

  private buildPrompt(name: string, hint?: string) {
    // Strong photorealism — free models otherwise invent surreal food-art
    const product = name.slice(0, 100).replace(/[",]/g, ' ').trim();
    const extra = hint
      ? hint.slice(0, 120).replace(/[",]/g, ' ').trim()
      : '';
    return [
      `Photorealistic food and product photograph of ${product}`,
      'authentic Indian restaurant style plating if it is a dish',
      extra || null,
      'real edible food on a clean white or marble surface',
      'natural colors appetizing look professional food photography',
      'soft studio lighting shallow depth of field',
      'shot on DSLR 50mm sharp detail high resolution',
      'menu catalog / Swiggy Zomato listing style',
      'true-to-life texture steam or garnish when natural',
      'no text no watermark no logo no price tag',
      'no illustration no cartoon no 3d render no surreal fantasy art no collage',
    ]
      .filter(Boolean)
      .join(', ');
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
        enhance: 'true',
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

  /**
   * Search Openverse for a real Creative-Commons photo of the product.
   * Much better than free AI for “looks real” catalog images.
   */
  async searchRealProductImage(dto: GenerateProductImageDto) {
    const name = dto.name.trim();
    if (name.length < 2) {
      throw new BadRequestException('Product name is required');
    }

    const queries = this.buildSearchQueries(name, dto.hint?.trim());
    let hit:
      | {
          title: string;
          url: string;
          thumbnail?: string;
          license?: string;
          foreign_landing_url?: string;
        }
      | undefined;

    for (const q of queries) {
      hit = await this.searchOpenverse(q);
      if (hit?.url) break;
    }

    if (!hit?.url) {
      throw new BadRequestException(
        'No real photo found for this name. Try a clearer name (e.g. Malai Kofta) or upload your own photo.',
      );
    }

    const imageUrl = hit.url;
    const result = await this.fetchImageHttps(imageUrl, {
      Accept: 'image/*,*/*',
      'User-Agent': 'UniversalPOS/1.0 (catalog; contact@upos.local)',
    });

    return {
      provider: 'openverse',
      prompt: queries[0],
      mime: result.mime,
      bytes: result.buf.length,
      imageBase64: `data:${result.mime};base64,${result.buf.toString('base64')}`,
      sourceUrl: imageUrl,
      attribution: {
        title: hit.title || name,
        license: hit.license || 'unknown',
        landingUrl: hit.foreign_landing_url || null,
      },
    };
  }

  private buildSearchQueries(name: string, hint?: string): string[] {
    const base = name.replace(/\s+/g, ' ').trim();
    const lower = base.toLowerCase();
    const out: string[] = [base];

    if (hint) out.push(`${base} ${hint}`.slice(0, 120));

    // Common Indian dish aliases / expansions
    if (lower.includes('kofta') && !lower.includes('malai')) {
      out.push('malai kofta');
      out.push('malai kofta indian food');
    }
    if (lower.includes('pani') && lower.includes('kofta')) {
      out.push('malai kofta');
      out.push('kofta curry indian');
    }
    if (lower.includes('pani puri') || lower === 'pani') {
      out.push('pani puri');
      out.push('golgappa');
    }

    out.push(`${base} food`);
    out.push(`${base} indian food`);

    // Last token only (e.g. kofta)
    const parts = lower.split(/\s+/).filter((p) => p.length > 2);
    if (parts.length > 1) {
      out.push(parts[parts.length - 1]);
      out.push(`${parts[parts.length - 1]} indian dish`);
    }

    return [...new Set(out.map((q) => q.trim()).filter((q) => q.length >= 2))];
  }

  private async searchOpenverse(query: string): Promise<
    | {
        title: string;
        url: string;
        thumbnail?: string;
        license?: string;
        foreign_landing_url?: string;
      }
    | undefined
  > {
    const url =
      `https://api.openverse.org/v1/images/?` +
      new URLSearchParams({
        q: query,
        page_size: '8',
        format: 'json',
      }).toString();

    const insecure = this.tlsInsecure();
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'UniversalPOS/1.0',
          },
          timeout: 25_000,
          rejectUnauthorized: !insecure,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('openverse timeout'));
      });
    });

    let json: {
      results?: Array<{
        title?: string;
        url?: string;
        thumbnail?: string;
        license?: string;
        foreign_landing_url?: string;
      }>;
    };
    try {
      json = JSON.parse(body.toString('utf8')) as typeof json;
    } catch {
      throw new Error('Openverse returned invalid JSON');
    }

    const results = json.results ?? [];
    // Prefer direct image URLs that look downloadable
    const preferred = results.find(
      (r) =>
        r.url &&
        /\.(jpe?g|png|webp)(\?|$)/i.test(r.url),
    );
    return preferred || results.find((r) => r.url) || undefined;
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
