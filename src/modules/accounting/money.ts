import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;

export function D(
  n: Prisma.Decimal | number | string | null | undefined,
): Prisma.Decimal {
  if (n instanceof Prisma.Decimal) return n;
  if (n == null || n === '') return new Prisma.Decimal(0);
  return new Prisma.Decimal(n);
}

export function money2(
  n: Prisma.Decimal | number | string | null | undefined,
): string {
  return D(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

export function isZero(n: Prisma.Decimal | number | string | null | undefined) {
  return D(n).abs().lessThan(new Prisma.Decimal('0.005'));
}

export function sumMoney(
  values: Array<Prisma.Decimal | number | string | null | undefined>,
): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((s, v) => s.add(D(v)), new Prisma.Decimal(0));
}

export type BalancedLine = {
  debit: Prisma.Decimal | number | string;
  credit: Prisma.Decimal | number | string;
};

export function assertDoubleEntry(lines: BalancedLine[], label = 'Journal') {
  if (!lines.length) {
    throw new BadRequestException(`${label} has no lines`);
  }
  let debit = new Prisma.Decimal(0);
  let credit = new Prisma.Decimal(0);
  for (const line of lines) {
    const d = D(line.debit);
    const c = D(line.credit);
    if (d.lt(0) || c.lt(0)) {
      throw new BadRequestException(`${label} amounts cannot be negative`);
    }
    if (!isZero(d) && !isZero(c)) {
      throw new BadRequestException(
        `${label} line cannot have both debit and credit`,
      );
    }
    if (isZero(d) && isZero(c)) {
      throw new BadRequestException(`${label} line is empty`);
    }
    debit = debit.add(d);
    credit = credit.add(c);
  }
  if (!debit.eq(credit)) {
    throw new BadRequestException(
      `${label} unbalanced: debit ${money2(debit)} credit ${money2(credit)}`,
    );
  }
  return { debit: money2(debit), credit: money2(credit) };
}
