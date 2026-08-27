-- Universal quantity engine: unit master tables, wider NUMERIC, line snapshots.
-- unit_groups / units / product_units lived only in schema.prisma (db push locally)
-- and were never created by a prior migrate. ALTER TABLE "units" is what failed
-- on production (P3009). This file is idempotent so it can be re-run after
-- `prisma migrate resolve --rolled-back 20260827120000_universal_qty_engine`.

DO $$ BEGIN
  CREATE TYPE "pricing_strategy" AS ENUM ('converted', 'fixed_tier');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "unit_groups" (
  "id" UUID NOT NULL,
  "code" VARCHAR(20) NOT NULL,
  "name" VARCHAR(50) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "unit_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "unit_groups_code_key" ON "unit_groups"("code");

CREATE TABLE IF NOT EXISTS "units" (
  "id" UUID NOT NULL,
  "unit_group_id" UUID NOT NULL,
  "tenant_id" UUID,
  "name" VARCHAR(50) NOT NULL,
  "symbol" VARCHAR(16) NOT NULL,
  "is_base_unit" BOOLEAN NOT NULL DEFAULT false,
  "conversion_to_group_base" DECIMAL(20, 8) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "units_unit_group_id_symbol_key" ON "units"("unit_group_id", "symbol");
CREATE INDEX IF NOT EXISTS "units_tenant_id_idx" ON "units"("tenant_id");

DO $$ BEGIN
  ALTER TABLE "units" ADD CONSTRAINT "units_unit_group_id_fkey"
    FOREIGN KEY ("unit_group_id") REFERENCES "unit_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "product_units" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "conversion_to_base" DECIMAL(20, 8) NOT NULL,
  "fixed_price" DECIMAL(14, 4),
  "is_default_selling_unit" BOOLEAN NOT NULL DEFAULT false,
  "is_purchase_unit" BOOLEAN NOT NULL DEFAULT false,
  "quantity_precision" INTEGER,
  "min_quantity" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "quantity_step" DECIMAL(20, 8),
  "allow_fraction" BOOLEAN,
  "barcode" VARCHAR(64),
  "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effective_to" TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_units_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_units_product_id_unit_id_effective_from_key"
  ON "product_units"("product_id", "unit_id", "effective_from");
CREATE INDEX IF NOT EXISTS "product_units_tenant_id_product_id_idx"
  ON "product_units"("tenant_id", "product_id");
CREATE INDEX IF NOT EXISTS "product_units_product_id_effective_to_idx"
  ON "product_units"("product_id", "effective_to");
CREATE INDEX IF NOT EXISTS "product_units_tenant_id_barcode_idx"
  ON "product_units"("tenant_id", "barcode");

DO $$ BEGIN
  ALTER TABLE "product_units" ADD CONSTRAINT "product_units_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "base_unit_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pricing_unit_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pricing_strategy" "pricing_strategy" NOT NULL DEFAULT 'converted';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "price_per_pricing_unit" DECIMAL(14, 4);
CREATE INDEX IF NOT EXISTS "products_tenant_id_base_unit_id_idx" ON "products"("tenant_id", "base_unit_id");

DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_id_fkey"
    FOREIGN KEY ("base_unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_pricing_unit_id_fkey"
    FOREIGN KEY ("pricing_unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "unit_groups" ("id", "code", "name", "is_active") VALUES
  (gen_random_uuid(), 'WEIGHT', 'Weight', true),
  (gen_random_uuid(), 'VOLUME', 'Volume', true),
  (gen_random_uuid(), 'LENGTH', 'Length', true),
  (gen_random_uuid(), 'AREA', 'Area', true),
  (gen_random_uuid(), 'COUNT', 'Count', true),
  (gen_random_uuid(), 'TIME', 'Time', true),
  (gen_random_uuid(), 'CUSTOM', 'Custom', true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "units" ("id", "unit_group_id", "tenant_id", "name", "symbol", "is_base_unit", "conversion_to_group_base", "is_active")
SELECT gen_random_uuid(), g."id", NULL, v."name", v."symbol", v."is_base", v."factor", true
FROM (VALUES
  ('WEIGHT', 'Gram', 'g', true, 1::numeric),
  ('WEIGHT', 'Kilogram', 'kg', false, 1000),
  ('WEIGHT', 'Milligram', 'mg', false, 0.001),
  ('WEIGHT', 'Tonne', 't', false, 1000000),
  ('WEIGHT', 'Pound', 'lb', false, 453.59237),
  ('WEIGHT', 'Ounce', 'oz', false, 28.349523125),
  ('VOLUME', 'Millilitre', 'ml', true, 1),
  ('VOLUME', 'Litre', 'L', false, 1000),
  ('VOLUME', 'Cubic metre', 'm3', false, 1000000),
  ('LENGTH', 'Millimetre', 'mm', true, 1),
  ('LENGTH', 'Centimetre', 'cm', false, 10),
  ('LENGTH', 'Metre', 'm', false, 1000),
  ('LENGTH', 'Inch', 'in', false, 25.4),
  ('LENGTH', 'Foot', 'ft', false, 304.8),
  ('AREA', 'Square metre', 'm2', true, 1),
  ('AREA', 'Square centimetre', 'cm2', false, 0.0001),
  ('COUNT', 'Piece', 'pcs', true, 1),
  ('COUNT', 'Pair', 'pair', false, 2),
  ('COUNT', 'Dozen', 'dozen', false, 12),
  ('COUNT', 'Pack', 'pack', false, 1),
  ('COUNT', 'Box', 'box', false, 1),
  ('COUNT', 'Case', 'case', false, 1),
  ('COUNT', 'Bag', 'bag', false, 1),
  ('COUNT', 'Carton', 'carton', false, 1),
  ('COUNT', 'Set', 'set', false, 1),
  ('COUNT', 'Service', 'service', false, 1),
  ('TIME', 'Minute', 'min', true, 1),
  ('TIME', 'Hour', 'hour', false, 60),
  ('TIME', 'Day', 'day', false, 1440),
  ('TIME', 'Week', 'week', false, 10080),
  ('TIME', 'Month', 'month', false, 43200)
) AS v("group_code", "name", "symbol", "is_base", "factor")
JOIN "unit_groups" g ON g."code" = v."group_code"
ON CONFLICT ("unit_group_id", "symbol") DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.upos_alter_type(tbl text, col text, typ text) RETURNS void AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = tbl AND column_name = col
  ) THEN
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE %s', tbl, col, typ);
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT pg_temp.upos_alter_type('products', 'unit_of_measure', 'VARCHAR(32)');
SELECT pg_temp.upos_alter_type('units', 'symbol', 'VARCHAR(16)');
SELECT pg_temp.upos_alter_type('stock_levels', 'sell_unit', 'VARCHAR(16)');
SELECT pg_temp.upos_alter_type('unit_conversions', 'factor', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('product_bundle_lines', 'quantity', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('product_batches', 'qty_on_hand', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'qty_on_hand', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'qty_reserved', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'qty_in_transit', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'qty_damaged', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'reorder_point', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_levels', 'reorder_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_ledger_entries', 'qty_before', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_ledger_entries', 'qty_delta', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_ledger_entries', 'qty_after', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_ledger_entries', 'damage_delta', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_count_lines', 'system_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_count_lines', 'counted_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_count_lines', 'variance', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_adjustment_lines', 'current_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_adjustment_lines', 'adjustment_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_adjustment_lines', 'new_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('qty_reservations', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_transfer_lines', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_transfer_lines', 'qty_received', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('stock_transfer_lines', 'qty_damaged', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('production_orders', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('purchase_order_lines', 'qty_ordered', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('purchase_order_lines', 'qty_received', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('purchase_return_lines', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('work_job_lines', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('kitchen_ticket_lines', 'quantity', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('modifier_options', 'quantity', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('recipe_stages', 'output_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('recipe_stages', 'consume_qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('goods_receipt_lines', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('intercompany_transfer_lines', 'quantity', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('wastage_events', 'qty', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('order_items', 'quantity', 'NUMERIC(20, 8)');
SELECT pg_temp.upos_alter_type('order_items', 'unit_price', 'NUMERIC(14, 4)');

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

ALTER TABLE "product_units" DROP CONSTRAINT IF EXISTS "product_units_conversion_positive";
ALTER TABLE "product_units"
  ADD CONSTRAINT "product_units_conversion_positive"
  CHECK ("conversion_to_base" > 0);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'unit_conversions') THEN
    ALTER TABLE "unit_conversions" DROP CONSTRAINT IF EXISTS "unit_conversions_factor_positive";
    ALTER TABLE "unit_conversions"
      ADD CONSTRAINT "unit_conversions_factor_positive"
      CHECK ("factor" > 0);
    ALTER TABLE "unit_conversions" DROP CONSTRAINT IF EXISTS "unit_conversions_distinct_units";
    ALTER TABLE "unit_conversions"
      ADD CONSTRAINT "unit_conversions_distinct_units"
      CHECK ("from_unit" <> "to_unit");
  END IF;
END $$;
