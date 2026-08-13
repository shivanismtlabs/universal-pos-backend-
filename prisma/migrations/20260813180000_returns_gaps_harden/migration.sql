-- Customer return hardening + supplier refund direction
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'customer_return';

ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "parent_payment_id" UUID;

-- Unique idempotency when key present (Postgres treats NULLs as distinct in unique)
CREATE UNIQUE INDEX IF NOT EXISTS "return_events_tenant_id_idempotency_key_key"
  ON "return_events"("tenant_id", "idempotency_key");

ALTER TABLE "refund_reasons" ADD COLUMN IF NOT EXISTS "applies_to" TEXT NOT NULL DEFAULT 'customer';

ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'payment';
CREATE INDEX IF NOT EXISTS "supplier_payments_tenant_id_kind_paid_at_idx"
  ON "supplier_payments"("tenant_id", "kind", "paid_at");
