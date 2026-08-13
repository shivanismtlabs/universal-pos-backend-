-- Sale return hardening + expense receipts/approval
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "reason_code" TEXT;
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "refund_amount" DECIMAL(12,2);
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "refund_method" TEXT;
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "items_json" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
ALTER TABLE "return_events" ADD COLUMN IF NOT EXISTS "reject_reason" TEXT;

CREATE INDEX IF NOT EXISTS "return_events_tenant_id_status_created_at_idx"
  ON "return_events"("tenant_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "return_events_tenant_id_order_id_idx"
  ON "return_events"("tenant_id", "order_id");

CREATE TABLE IF NOT EXISTS "refund_reasons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_reasons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refund_reasons_tenant_id_code_key"
  ON "refund_reasons"("tenant_id", "code");
CREATE INDEX IF NOT EXISTS "refund_reasons_tenant_id_is_active_idx"
  ON "refund_reasons"("tenant_id", "is_active");

DO $$ BEGIN
  ALTER TABLE "refund_reasons"
    ADD CONSTRAINT "refund_reasons_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receipt_url" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "approved_by_id" UUID;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6);
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reject_reason" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "expenses_tenant_id_status_idx"
  ON "expenses"("tenant_id", "status");

DO $$ BEGIN
  ALTER TABLE "expenses"
    ADD CONSTRAINT "expenses_approved_by_id_fkey"
    FOREIGN KEY ("approved_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
