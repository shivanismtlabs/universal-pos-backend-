-- Universal quantity engine: wider NUMERIC, line snapshots, product-unit constraints.

ALTER TABLE "products"
  ALTER COLUMN "unit_of_measure" TYPE VARCHAR(32);

ALTER TABLE "units"
  ALTER COLUMN "symbol" TYPE VARCHAR(16);

ALTER TABLE "stock_levels"
  ALTER COLUMN "sell_unit" TYPE VARCHAR(16);

ALTER TABLE "unit_conversions"
  ALTER COLUMN "factor" TYPE NUMERIC(20, 8);

-- Quantity columns → NUMERIC(20, 8)
ALTER TABLE "product_bundle_lines" ALTER COLUMN "quantity" TYPE NUMERIC(20, 8);
ALTER TABLE "product_batches" ALTER COLUMN "qty_on_hand" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "qty_on_hand" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "qty_reserved" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "qty_in_transit" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "qty_damaged" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "reorder_point" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_levels" ALTER COLUMN "reorder_qty" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_ledger_entries" ALTER COLUMN "qty_before" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_ledger_entries" ALTER COLUMN "qty_delta" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_ledger_entries" ALTER COLUMN "qty_after" TYPE NUMERIC(20, 8);
ALTER TABLE "stock_ledger_entries" ALTER COLUMN "damage_delta" TYPE NUMERIC(20, 8);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stock_count_lines' AND column_name = 'system_qty') THEN
    ALTER TABLE "stock_count_lines" ALTER COLUMN "system_qty" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_count_lines" ALTER COLUMN "counted_qty" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_count_lines" ALTER COLUMN "variance" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stock_adjustment_lines' AND column_name = 'current_qty') THEN
    ALTER TABLE "stock_adjustment_lines" ALTER COLUMN "current_qty" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_adjustment_lines" ALTER COLUMN "adjustment_qty" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_adjustment_lines" ALTER COLUMN "new_qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'qty_reservations' AND column_name = 'qty') THEN
    ALTER TABLE "qty_reservations" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stock_transfer_lines' AND column_name = 'qty') THEN
    ALTER TABLE "stock_transfer_lines" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_transfer_lines" ALTER COLUMN "qty_received" TYPE NUMERIC(20, 8);
    ALTER TABLE "stock_transfer_lines" ALTER COLUMN "qty_damaged" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'production_orders' AND column_name = 'qty') THEN
    ALTER TABLE "production_orders" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_order_lines' AND column_name = 'qty_ordered') THEN
    ALTER TABLE "purchase_order_lines" ALTER COLUMN "qty_ordered" TYPE NUMERIC(20, 8);
    ALTER TABLE "purchase_order_lines" ALTER COLUMN "qty_received" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_return_lines' AND column_name = 'qty') THEN
    ALTER TABLE "purchase_return_lines" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'work_job_lines' AND column_name = 'qty') THEN
    ALTER TABLE "work_job_lines" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kitchen_ticket_lines' AND column_name = 'quantity') THEN
    ALTER TABLE "kitchen_ticket_lines" ALTER COLUMN "quantity" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'modifier_options' AND column_name = 'quantity') THEN
    ALTER TABLE "modifier_options" ALTER COLUMN "quantity" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'recipe_stages' AND column_name = 'output_qty') THEN
    ALTER TABLE "recipe_stages" ALTER COLUMN "output_qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'recipe_stages' AND column_name = 'consume_qty') THEN
    ALTER TABLE "recipe_stages" ALTER COLUMN "consume_qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'goods_receipt_lines' AND column_name = 'qty') THEN
    ALTER TABLE "goods_receipt_lines" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intercompany_transfer_lines' AND column_name = 'quantity') THEN
    ALTER TABLE "intercompany_transfer_lines" ALTER COLUMN "quantity" TYPE NUMERIC(20, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wastage_events' AND column_name = 'qty') THEN
    ALTER TABLE "wastage_events" ALTER COLUMN "qty" TYPE NUMERIC(20, 8);
  END IF;
END $$;

ALTER TABLE "order_items" ALTER COLUMN "quantity" TYPE NUMERIC(20, 8);
ALTER TABLE "order_items" ALTER COLUMN "unit_price" TYPE NUMERIC(14, 4);

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "ordered_quantity" NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS "ordered_unit_id" UUID,
  ADD COLUMN IF NOT EXISTS "ordered_unit_symbol" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "base_quantity" NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS "base_unit_id" UUID,
  ADD COLUMN IF NOT EXISTS "base_unit_symbol" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "conversion_factor" NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS "price_source" VARCHAR(24);

UPDATE "order_items"
SET
  "ordered_quantity" = COALESCE("ordered_quantity", "quantity"),
  "base_quantity" = COALESCE("base_quantity", "quantity")
WHERE "ordered_quantity" IS NULL OR "base_quantity" IS NULL;

ALTER TABLE "product_units"
  ADD COLUMN IF NOT EXISTS "quantity_precision" INTEGER,
  ADD COLUMN IF NOT EXISTS "min_quantity" NUMERIC(20, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "quantity_step" NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS "allow_fraction" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "barcode" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "product_units_tenant_id_barcode_idx"
  ON "product_units" ("tenant_id", "barcode");

ALTER TABLE "product_units" DROP CONSTRAINT IF EXISTS "product_units_conversion_positive";
ALTER TABLE "product_units"
  ADD CONSTRAINT "product_units_conversion_positive"
  CHECK ("conversion_to_base" > 0);

ALTER TABLE "unit_conversions" DROP CONSTRAINT IF EXISTS "unit_conversions_factor_positive";
ALTER TABLE "unit_conversions"
  ADD CONSTRAINT "unit_conversions_factor_positive"
  CHECK ("factor" > 0);

ALTER TABLE "unit_conversions" DROP CONSTRAINT IF EXISTS "unit_conversions_distinct_units";
ALTER TABLE "unit_conversions"
  ADD CONSTRAINT "unit_conversions_distinct_units"
  CHECK ("from_unit" <> "to_unit");
