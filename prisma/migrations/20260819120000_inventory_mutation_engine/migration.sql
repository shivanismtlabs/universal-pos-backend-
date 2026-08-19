-- Inventory mutation engine: ledger completeness, variant stock, reservations,
-- transfer lifecycle, consumption/production, UOM, idempotency.

ALTER TYPE "StockUnitStatus" ADD VALUE IF NOT EXISTS 'sold';
ALTER TYPE "StockUnitStatus" ADD VALUE IF NOT EXISTS 'lost';

ALTER TYPE "SyncStatus" ADD VALUE IF NOT EXISTS 'retry';

ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'opening';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'consumption';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'production_in';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'production_out';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'expiry';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'reservation';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'reservation_release';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'rental_out';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'rental_return';

DO $$ BEGIN
  CREATE TYPE "QtyReservationStatus" AS ENUM ('active', 'released', 'consumed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StockTransferStatus" AS ENUM (
    'draft', 'approved', 'issued', 'in_transit',
    'partially_received', 'received', 'cancelled', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProductionOrderStatus" AS ENUM ('draft', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "stock_levels"
  ADD COLUMN IF NOT EXISTS "variant_id" UUID,
  ADD COLUMN IF NOT EXISTS "variant_key" VARCHAR(36) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "qty_reserved" DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "qty_in_transit" DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "stock_levels" DROP CONSTRAINT IF EXISTS "stock_levels_tenant_id_location_id_product_id_key";
DROP INDEX IF EXISTS "stock_levels_tenant_id_location_id_product_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "stock_levels_tenant_id_location_id_product_id_variant_key_key"
  ON "stock_levels"("tenant_id", "location_id", "product_id", "variant_key");

DO $$ BEGIN
  ALTER TABLE "stock_levels"
    ADD CONSTRAINT "stock_levels_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "stock_ledger_entries"
  ADD COLUMN IF NOT EXISTS "qty_before" DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "variant_id" UUID,
  ADD COLUMN IF NOT EXISTS "batch_id" UUID,
  ADD COLUMN IF NOT EXISTS "stock_unit_id" UUID,
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(120);

CREATE INDEX IF NOT EXISTS "stock_ledger_entries_tenant_id_idempotency_key_idx"
  ON "stock_ledger_entries"("tenant_id", "idempotency_key");

ALTER TABLE "product_bundle_lines"
  ADD COLUMN IF NOT EXISTS "consume_on_sale" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "purpose" VARCHAR(24) NOT NULL DEFAULT 'bundle';

ALTER TABLE "purchase_order_lines"
  ALTER COLUMN "qty_ordered" TYPE DECIMAL(12,3) USING "qty_ordered"::DECIMAL(12,3),
  ALTER COLUMN "qty_received" TYPE DECIMAL(12,3) USING "qty_received"::DECIMAL(12,3);

CREATE TABLE IF NOT EXISTS "qty_reservations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "location_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "variant_id" UUID,
  "batch_id" UUID,
  "stock_level_id" UUID,
  "order_id" UUID,
  "customer_id" UUID,
  "qty" DECIMAL(12,3) NOT NULL,
  "status" "QtyReservationStatus" NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMPTZ(6),
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "qty_reservations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "qty_reservations_tenant_id_location_id_product_id_status_idx"
  ON "qty_reservations"("tenant_id", "location_id", "product_id", "status");

DO $$ BEGIN
  ALTER TABLE "qty_reservations" ADD CONSTRAINT "qty_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "qty_reservations" ADD CONSTRAINT "qty_reservations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "qty_reservations" ADD CONSTRAINT "qty_reservations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "qty_reservations" ADD CONSTRAINT "qty_reservations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "inventory_idempotency" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" VARCHAR(160) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_idempotency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_idempotency_tenant_id_key_key"
  ON "inventory_idempotency"("tenant_id", "key");
DO $$ BEGIN
  ALTER TABLE "inventory_idempotency" ADD CONSTRAINT "inventory_idempotency_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "from_location_id" UUID NOT NULL,
  "to_location_id" UUID NOT NULL,
  "status" "StockTransferStatus" NOT NULL DEFAULT 'draft',
  "notes" TEXT,
  "actor_user_id" UUID,
  "issued_at" TIMESTAMPTZ(6),
  "received_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_transfers_tenant_id_status_created_at_idx"
  ON "stock_transfers"("tenant_id", "status", "created_at");
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "stock_transfer_lines" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "transfer_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "variant_id" UUID,
  "batch_id" UUID,
  "qty" DECIMAL(12,3) NOT NULL,
  "qty_received" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "qty_damaged" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines"("transfer_id");
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "unit_conversions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "product_id" UUID,
  "product_key" VARCHAR(36) NOT NULL DEFAULT '',
  "from_unit" VARCHAR(16) NOT NULL,
  "to_unit" VARCHAR(16) NOT NULL,
  "factor" DECIMAL(18,6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "unit_conversions_tenant_id_product_key_from_unit_to_unit_key"
  ON "unit_conversions"("tenant_id", "product_key", "from_unit", "to_unit");
DO $$ BEGIN
  ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "production_orders" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "location_id" UUID NOT NULL,
  "finished_product_id" UUID NOT NULL,
  "finished_variant_id" UUID,
  "qty" DECIMAL(12,3) NOT NULL,
  "status" "ProductionOrderStatus" NOT NULL DEFAULT 'draft',
  "notes" TEXT,
  "actor_user_id" UUID,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "production_orders_tenant_id_status_idx" ON "production_orders"("tenant_id", "status");
DO $$ BEGIN
  ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_finished_product_id_fkey" FOREIGN KEY ("finished_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill variant stock rows at 0 qty (do not steal product-level on-hand).
INSERT INTO "stock_levels" (
  "id", "tenant_id", "location_id", "product_id", "sku", "sell_unit",
  "variant_id", "variant_key", "qty_on_hand", "sell_price", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  sl."tenant_id",
  sl."location_id",
  v."product_id",
  LEFT(v."sku_code", 18),
  sl."sell_unit",
  v."id",
  v."id"::text,
  0,
  COALESCE(v."base_price", sl."sell_price"),
  NOW(),
  NOW()
FROM "product_variants" v
JOIN "stock_levels" sl
  ON sl."tenant_id" = v."tenant_id"
 AND sl."product_id" = v."product_id"
 AND sl."variant_key" = ''
ON CONFLICT ("tenant_id", "location_id", "product_id", "variant_key") DO NOTHING;

