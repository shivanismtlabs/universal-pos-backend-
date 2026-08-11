-- Inventory management: stock ledger, counts, reorder, damaged qty

DO $$ BEGIN
  CREATE TYPE "StockLedgerType" AS ENUM (
    'stock_in', 'stock_out', 'adjustment', 'transfer_in', 'transfer_out',
    'purchase_receive', 'purchase_return', 'sale', 'damage', 'damage_restore', 'audit'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "StockCountStatus" AS ENUM ('draft', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "stock_levels" ADD COLUMN IF NOT EXISTS "qty_damaged" DECIMAL(12,3) NOT NULL DEFAULT 0;
ALTER TABLE "stock_levels" ADD COLUMN IF NOT EXISTS "reorder_point" DECIMAL(12,3);
ALTER TABLE "stock_levels" ADD COLUMN IF NOT EXISTS "reorder_qty" DECIMAL(12,3);

CREATE TABLE IF NOT EXISTS "stock_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "stock_level_id" UUID NOT NULL,
    "type" "StockLedgerType" NOT NULL,
    "qty_delta" DECIMAL(12,3) NOT NULL,
    "qty_after" DECIMAL(12,3) NOT NULL,
    "damage_delta" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reference_type" TEXT,
    "reference_id" UUID,
    "actor_user_id" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_ledger_entries_tenant_id_created_at_idx" ON "stock_ledger_entries"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "stock_ledger_entries_tenant_id_location_id_created_at_idx" ON "stock_ledger_entries"("tenant_id", "location_id", "created_at");
CREATE INDEX IF NOT EXISTS "stock_ledger_entries_tenant_id_product_id_created_at_idx" ON "stock_ledger_entries"("tenant_id", "product_id", "created_at");

ALTER TABLE "stock_ledger_entries" DROP CONSTRAINT IF EXISTS "stock_ledger_entries_tenant_id_fkey";
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_ledger_entries" DROP CONSTRAINT IF EXISTS "stock_ledger_entries_location_id_fkey";
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_ledger_entries" DROP CONSTRAINT IF EXISTS "stock_ledger_entries_product_id_fkey";
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_ledger_entries" DROP CONSTRAINT IF EXISTS "stock_ledger_entries_stock_level_id_fkey";
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_stock_level_id_fkey" FOREIGN KEY ("stock_level_id") REFERENCES "stock_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_ledger_entries" DROP CONSTRAINT IF EXISTS "stock_ledger_entries_actor_user_id_fkey";
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "stock_count_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "started_by_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_count_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_count_sessions_tenant_id_location_id_status_idx" ON "stock_count_sessions"("tenant_id", "location_id", "status");
ALTER TABLE "stock_count_sessions" DROP CONSTRAINT IF EXISTS "stock_count_sessions_tenant_id_fkey";
ALTER TABLE "stock_count_sessions" ADD CONSTRAINT "stock_count_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_sessions" DROP CONSTRAINT IF EXISTS "stock_count_sessions_location_id_fkey";
ALTER TABLE "stock_count_sessions" ADD CONSTRAINT "stock_count_sessions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "stock_count_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "stock_level_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "system_qty" DECIMAL(12,3) NOT NULL,
    "counted_qty" DECIMAL(12,3),
    "variance" DECIMAL(12,3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_lines_session_id_stock_level_id_key" ON "stock_count_lines"("session_id", "stock_level_id");
ALTER TABLE "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_tenant_id_fkey";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_session_id_fkey";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "stock_count_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_stock_level_id_fkey";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_level_id_fkey" FOREIGN KEY ("stock_level_id") REFERENCES "stock_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_product_id_fkey";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
