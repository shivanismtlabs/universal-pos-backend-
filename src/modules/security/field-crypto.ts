import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function keyFromConfig(raw: string | undefined, fallback: string): Buffer {
  const src = (raw?.trim() || fallback).trim();
  return createHash('sha256').update(`upos-sec-v1:${src}`).digest();
}

export function encryptField(plaintext: string, keyMaterial: string): string {
  const key = keyFromConfig(keyMaterial, 'dev-only-change-me');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptField(packed: string, keyMaterial: string): string {
  const parts = packed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid ciphertext');
  }
  const key = keyFromConfig(keyMaterial, 'dev-only-change-me');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const data = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
