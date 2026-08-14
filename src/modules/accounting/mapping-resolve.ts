import { Prisma } from '@prisma/client';
import { MAP, type MappingKey } from './constants';

export type Tx = Prisma.TransactionClient;

export const MAPPING_FALLBACKS: Record<string, MappingKey[]> = {
  output_cgst: [MAP.output_gst],
  output_sgst: [MAP.output_gst],
  output_igst: [MAP.output_gst],
  output_cess: [MAP.output_gst],
  input_cgst: [MAP.input_gst],
  input_sgst: [MAP.input_gst],
  input_igst: [MAP.input_gst],
  service_revenue: [MAP.sales],
  rental_revenue: [MAP.sales],
  subscription_revenue: [MAP.sales],
  purchase: [MAP.inventory, MAP.expense_default],
  purchase_return: [MAP.purchase, MAP.inventory],
  sales_return: [MAP.sales],
  discounts: [MAP.sales],
  deposits: [MAP.customer_advances],
  gift_card: [MAP.customer_advances],
  store_credit: [MAP.customer_advances],
  wallet: [MAP.cash],
  other_tender: [MAP.cash],
  card: [MAP.bank],
  upi: [MAP.bank],
  bank: [MAP.cash],
  expense_default: [MAP.cogs],
};

export async function resolveAccountId(
  tx: Tx,
  tenantId: string,
  mappingKey: string,
  locationId?: string | null,
): Promise<string> {
  const keys = [mappingKey, ...(MAPPING_FALLBACKS[mappingKey] ?? [])];
  if (locationId) {
    for (const key of keys) {
      const loc = await tx.accountMapping.findFirst({
        where: {
          tenantId,
          mappingKey: key,
          scopeKey: locationId,
          account: { isActive: true },
        },
        select: { accountId: true },
      });
      if (loc) return loc.accountId;
    }
  }
  for (const key of keys) {
    const row = await tx.accountMapping.findFirst({
      where: {
        tenantId,
        mappingKey: key,
        scopeKey: '*',
        account: { isActive: true },
      },
      select: { accountId: true },
    });
    if (row) return row.accountId;
  }
  throw new Error(`Account mapping missing for "${mappingKey}"`);
}

export function sourceKey(sourceType: string, sourceId: string) {
  return `${sourceType}:${sourceId}`;
}
