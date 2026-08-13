-- Purchase order fields used by createPo but missing from prior migrations
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "po_number" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_id_po_number_idx"
  ON "purchase_orders"("tenant_id", "po_number");

CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "purchase_order_id" UUID NOT NULL,
  "stock_level_id" UUID NOT NULL,
  "qty_ordered" INTEGER NOT NULL,
  "qty_received" INTEGER NOT NULL DEFAULT 0,
  "unit_cost" DECIMAL(12,2),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "purchase_order_lines_tenant_id_purchase_order_id_idx"
  ON "purchase_order_lines"("tenant_id", "purchase_order_id");

DO $$ BEGIN
  ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_stock_level_id_fkey"
    FOREIGN KEY ("stock_level_id") REFERENCES "stock_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
