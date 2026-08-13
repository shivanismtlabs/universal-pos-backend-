import { Prisma } from '@prisma/client';

const money = (n: Prisma.Decimal | string | number) => new Prisma.Decimal(n);

export type SoldLineForReturn = {
  stockLevelId: string | null;
  quantity: Prisma.Decimal | string | number;
  unitPrice: Prisma.Decimal | string | number;
  lineTotal: Prisma.Decimal | string | number;
  taxAmount?: Prisma.Decimal | string | number | null;
};

export type ReturnQtyLine = {
  stockLevelId: string;
  quantity: number;
  condition?: string;
};

export type ComputedReturnLine = {
  stockLevelId: string;
  quantity: number;
  unitPrice: number;
  condition: string;
  /** Net merchandise share (excl. tax) for returned qty */
  netShare: number;
  /** Tax share for returned qty (from original lines) */
  taxShare: number;
  /** Allocated order-level discount share */
  discountShare: number;
  /** Refundable for this line after discount */
  refundShare: number;
};

/**
 * Refund from the original sale: proportional line net + tax,
 * minus a share of order-level discount. Never invents tax rates.
 */
export function computeReturnRefundFromOriginal(args: {
  orderSubtotal: number;
  orderTaxTotal: number;
  orderDiscountTotal: number;
  soldItems: SoldLineForReturn[];
  returnItems: ReturnQtyLine[];
}): { amount: number; lines: ComputedReturnLine[] } {
  const merchandise = Math.max(
    0,
    Number(
      money(args.orderSubtotal).add(args.orderTaxTotal).toFixed(2),
    ),
  );
  const discount = Math.max(0, Number(money(args.orderDiscountTotal).toFixed(2)));

  const byLevel = new Map<
    string,
    { soldQty: number; net: number; tax: number; unitPrice: number }
  >();

  for (const item of args.soldItems) {
    if (!item.stockLevelId) continue;
    const qty = Number(item.quantity);
    const net = Number(item.lineTotal);
    const tax = Number(item.taxAmount ?? 0);
    const unit = Number(item.unitPrice);
    const prev = byLevel.get(item.stockLevelId);
    if (prev) {
      prev.soldQty += qty;
      prev.net += net;
      prev.tax += tax;
    } else {
      byLevel.set(item.stockLevelId, {
        soldQty: qty,
        net,
        tax,
        unitPrice: unit,
      });
    }
  }

  const lines: ComputedReturnLine[] = [];
  let grossBeforeDiscount = money(0);

  for (const ret of args.returnItems) {
    const sold = byLevel.get(ret.stockLevelId);
    if (!sold || sold.soldQty <= 0) {
      throw new Error(`Item ${ret.stockLevelId} was not on this sale`);
    }
    if (ret.quantity > sold.soldQty + 1e-9) {
      throw new Error(
        `Cannot return ${ret.quantity} (sold ${sold.soldQty})`,
      );
    }
    const share = ret.quantity / sold.soldQty;
    const netShare = Number(money(sold.net).mul(share).toFixed(2));
    const taxShare = Number(money(sold.tax).mul(share).toFixed(2));
    const lineGross = Number(money(netShare).add(taxShare).toFixed(2));
    grossBeforeDiscount = grossBeforeDiscount.add(lineGross);
    lines.push({
      stockLevelId: ret.stockLevelId,
      quantity: ret.quantity,
      unitPrice: sold.unitPrice,
      condition: ret.condition?.trim() || 'good',
      netShare,
      taxShare,
      discountShare: 0,
      refundShare: lineGross,
    });
  }

  const grossNum = Number(grossBeforeDiscount.toFixed(2));
  const allocatedDiscount = Number(
    merchandise > 0
      ? money(discount).mul(grossNum).div(merchandise).toFixed(2)
      : '0',
  );
  let discountLeft = money(allocatedDiscount);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineGross = Number(money(line.netShare).add(line.taxShare).toFixed(2));
    let disc = 0;
    if (discountLeft.gt(0) && grossNum > 0) {
      if (i === lines.length - 1) {
        disc = Number(discountLeft.toFixed(2));
      } else {
        disc = Number(
          money(lineGross).mul(allocatedDiscount).div(grossNum).toFixed(2),
        );
        discountLeft = discountLeft.sub(disc);
      }
    }
    line.discountShare = disc;
    line.refundShare = Number(money(lineGross).sub(disc).toFixed(2));
  }

  const amount = Number(
    lines
      .reduce((s, l) => s.add(l.refundShare), money(0))
      .toFixed(2),
  );

  return { amount, lines };
}
