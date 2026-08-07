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
