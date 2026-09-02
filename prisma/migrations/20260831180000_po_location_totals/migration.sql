-- Receive location + persisted PO money (not notes-only tax/discount)
ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "location_id" UUID,
  ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discount_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tax_percent" DECIMAL(8, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tax_total" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grand_total" DECIMAL(14, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_id_location_id_idx"
  ON "purchase_orders"("tenant_id", "location_id");

DO $$ BEGIN
  ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
