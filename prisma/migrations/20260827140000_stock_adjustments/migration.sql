-- Formal Zoho-style stock adjustment documents (header + lines).
-- Schema already referenced these tables; they were never created in earlier migrations.

DO $$ BEGIN
  CREATE TYPE "StockAdjustmentStatus" AS ENUM ('draft', 'pending', 'adjusted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "StockAdjustmentType" AS ENUM ('quantity', 'value');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "stock_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "adjustment_no" VARCHAR(32) NOT NULL,
    "adjustment_date" TIMESTAMPTZ(6) NOT NULL,
    "type" "StockAdjustmentType" NOT NULL DEFAULT 'quantity',
    "status" "StockAdjustmentStatus" NOT NULL DEFAULT 'draft',
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "finalized_at" TIMESTAMPTZ(6),
    "finalized_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stock_adjustments_tenant_id_adjustment_no_key"
  ON "stock_adjustments"("tenant_id", "adjustment_no");
CREATE INDEX IF NOT EXISTS "stock_adjustments_tenant_id_location_id_status_idx"
  ON "stock_adjustments"("tenant_id", "location_id", "status");
CREATE INDEX IF NOT EXISTS "stock_adjustments_tenant_id_created_at_idx"
  ON "stock_adjustments"("tenant_id", "created_at");

ALTER TABLE "stock_adjustments" DROP CONSTRAINT IF EXISTS "stock_adjustments_tenant_id_fkey";
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" DROP CONSTRAINT IF EXISTS "stock_adjustments_location_id_fkey";
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" DROP CONSTRAINT IF EXISTS "stock_adjustments_created_by_id_fkey";
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" DROP CONSTRAINT IF EXISTS "stock_adjustments_finalized_by_id_fkey";
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_finalized_by_id_fkey"
  FOREIGN KEY ("finalized_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" DROP CONSTRAINT IF EXISTS "stock_adjustments_cancelled_by_id_fkey";
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_cancelled_by_id_fkey"
  FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "stock_adjustment_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "adjustment_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "stock_level_id" UUID,
    "current_qty" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "adjustment_qty" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "new_qty" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "unit" VARCHAR(16) NOT NULL DEFAULT 'pcs',
    "current_unit_cost" DECIMAL(12, 2),
    "adjustment_value" DECIMAL(12, 2),
    "serial_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_adjustment_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "stock_adjustment_lines_tenant_id_adjustment_id_idx"
  ON "stock_adjustment_lines"("tenant_id", "adjustment_id");
CREATE INDEX IF NOT EXISTS "stock_adjustment_lines_tenant_id_product_id_idx"
  ON "stock_adjustment_lines"("tenant_id", "product_id");

ALTER TABLE "stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "stock_adjustment_lines_tenant_id_fkey";
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "stock_adjustment_lines_adjustment_id_fkey";
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_id_fkey"
  FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "stock_adjustment_lines_product_id_fkey";
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "stock_adjustment_lines_stock_level_id_fkey";
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_stock_level_id_fkey"
  FOREIGN KEY ("stock_level_id") REFERENCES "stock_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
