import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Table/column missing — schema not migrated (P2021/P2022). */
export function isMissingRelation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2021' || error.code === 'P2022') return true;
  }
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /does not exist|P2021|P2022/i.test(msg);
}

/** Postgres exclusion / check violation (e.g. reservation overlap) */
export function isExclusionViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  // Prisma wraps some as P2002/P2010; raw driver message often 23P01
  const meta = error.meta as { code?: string; message?: string } | undefined;
  const msg = `${error.message} ${meta?.message ?? ''}`;
  return (
    meta?.code === '23P01' ||
    msg.includes('23P01') ||
    msg.includes('unit_reservations_no_overlap') ||
    msg.includes('exclusion constraint')
  );
}

export function throwIfUnique(
  error: unknown,
  message = 'Duplicate record',
): never {
  if (isUniqueViolation(error)) {
    throw new ConflictException(message);
  }
  throw error;
}
