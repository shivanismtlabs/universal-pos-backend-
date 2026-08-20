import { BadRequestException } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
]);

/**
 * Save a product image under uploads/products/{tenantId}/…
 * Returns public path `/v1/uploads/products/…`
 */
export async function saveProductImage(
  tenantId: string,
  imageBase64: string,
): Promise<string> {
  const raw = imageBase64.trim();
  let mime = 'image/jpeg';
  let buffer: Buffer;

  const dataUrlB64 = /^data:([^;,]+);base64,(.+)$/is.exec(raw);
  const dataUrlPlain = /^data:([^;,]+)(?:;charset=[^,]+)?,(.+)$/is.exec(raw);

  if (dataUrlB64) {
    mime = dataUrlB64[1].toLowerCase().trim();
    try {
      buffer = Buffer.from(dataUrlB64[2], 'base64');
    } catch {
      throw new BadRequestException('Invalid image data');
    }
  } else if (dataUrlPlain && !/;base64,/i.test(raw)) {
    mime = dataUrlPlain[1].toLowerCase().trim();
    try {
      buffer = Buffer.from(decodeURIComponent(dataUrlPlain[2]), 'utf8');
    } catch {
      throw new BadRequestException('Invalid image data');
    }
  } else {
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      throw new BadRequestException('Invalid image data');
    }
  }

  const ext = ALLOWED.get(mime);
  if (!ext) {
    throw new BadRequestException(
      'Image must be JPEG, PNG, WebP, GIF, or SVG',
    );
  }

  if (!buffer.length || buffer.length > MAX_BYTES) {
    throw new BadRequestException('Image must be between 1 byte and 4 MB');
  }

  const dir = join(process.cwd(), 'uploads', 'products', tenantId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(join(dir, filename), buffer);

  return `/v1/uploads/products/${tenantId}/${filename}`;
}

function mimeFromMagic(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  return null;
}

function normalizeRemoteImageUrl(url: string): string {
  if (/^https:\/\/images\.unsplash\.com\/photo-[^?]+$/i.test(url)) {
    return `${url}?auto=format&fit=crop&w=800&q=80`;
  }
  return url;
}

/**
 * Download an http(s) catalog image and store it under uploads/.
 */
export async function saveRemoteProductImage(
  tenantId: string,
  imageUrl: string,
): Promise<string> {
  const url = normalizeRemoteImageUrl(imageUrl.trim());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        'User-Agent': 'UniversalPOS/1.0 (catalog import)',
      },
    });
    if (!res.ok) {
      throw new BadRequestException(`Could not download image (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const headerMime = (res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const mime = headerMime.startsWith('image/')
      ? headerMime === 'image/jpg'
        ? 'image/jpeg'
        : headerMime
      : mimeFromMagic(buf);
    if (!mime) {
      throw new BadRequestException('Downloaded file is not an image');
    }
    return saveProductImage(
      tenantId,
      `data:${mime};base64,${buf.toString('base64')}`,
    );
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    throw new BadRequestException(
      e instanceof Error ? e.message : 'Could not download image',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist data-URL images; download http(s) photos; keep local upload paths.
 * Remote download failures fall back to storing the original URL.
 */
export async function resolveProductPhoto(
  tenantId: string,
  raw?: string | null,
): Promise<string | null> {
  const value = raw?.trim();
  if (!value) return null;
  if (value.startsWith('data:')) {
    return saveProductImage(tenantId, value);
  }
  if (value.startsWith('/v1/uploads/')) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      return await saveRemoteProductImage(tenantId, value);
    } catch {
      return value;
    }
  }
  return value;
}
