/**
 * Category parent → children walk (one catalog tree per tenant).
 */

type CategoryRow = { id: string; parentId: string | null };

export function expandCategoryWithDescendants(
  rows: CategoryRow[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

export async function categoryIdsWithDescendants(
  db: {
    category: {
      findMany: (args: {
        where: { tenantId: string };
        select: { id: true; parentId: true };
      }) => Promise<CategoryRow[]>;
    };
  },
  tenantId: string,
  categoryId: string,
): Promise<string[]> {
  const rows = await db.category.findMany({
    where: { tenantId },
    select: { id: true, parentId: true },
  });
  if (!rows.some((r) => r.id === categoryId)) return [categoryId];
  return expandCategoryWithDescendants(rows, categoryId);
}
