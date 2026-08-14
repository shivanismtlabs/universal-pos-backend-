import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

export function isPrismaSchemaMismatch(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2021' || e.code === 'P2022';
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /does not exist|Unknown arg|Unknown field/i.test(msg);
}

/** bcrypt.compare that never throws (bad/truncated hashes → false). */
export async function safePasswordMatch(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash || hash.length < 20) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export function rethrowAuthDb(e: unknown): never {
  if (e instanceof HttpException) throw e;
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2021' || e.code === 'P2022') {
      throw new ServiceUnavailableException(
        'Database schema is out of date. On the API server run: npx prisma db push && npx prisma generate, then restart the API.',
      );
    }
    if (e.code === 'P2002') {
      throw new ConflictException(
        'This account is already linked to a shop. Sign in again.',
      );
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/JWT_REFRESH_SECRET|JWT_ACCESS_SECRET/.test(msg)) {
    throw new ServiceUnavailableException(
      'JWT secrets are missing in the API .env (JWT_ACCESS_SECRET and JWT_REFRESH_SECRET).',
    );
  }
  throw e;
}
