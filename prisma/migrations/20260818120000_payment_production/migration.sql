-- Payment lifecycle + register linkage + Stripe webhook inbox
-- New PaymentStatus values (must precede any DML that uses them).

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'created';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'initiated';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'processing';

CREATE TYPE "RegisterCashMovementKind" AS ENUM ('cash_in', 'cash_drop');

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "location_id" UUID,
  ADD COLUMN IF NOT EXISTS "register_session_id" UUID,
  ADD COLUMN IF NOT EXISTS "provider" TEXT,
  ADD COLUMN IF NOT EXISTS "failure_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "parent_payment_id" UUID;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_register_session_id_fkey"
  FOREIGN KEY ("register_session_id") REFERENCES "register_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_parent_payment_id_fkey"
  FOREIGN KEY ("parent_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "payments_tenant_id_gateway_ref_idx" ON "payments"("tenant_id", "gateway_ref");
CREATE INDEX IF NOT EXISTS "payments_tenant_id_register_session_id_idx" ON "payments"("tenant_id", "register_session_id");
CREATE INDEX IF NOT EXISTS "payments_tenant_id_order_id_status_idx" ON "payments"("tenant_id", "order_id", "status");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" UUID NOT NULL,
  "tenant_id" UUID,
  "stripe_event_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payment_intent_id" TEXT,
  "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_webhook_events_stripe_event_id_key" UNIQUE ("stripe_event_id"),
  CONSTRAINT "stripe_webhook_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_tenant_id_payment_intent_id_idx"
  ON "stripe_webhook_events"("tenant_id", "payment_intent_id");

CREATE TABLE IF NOT EXISTS "register_cash_movements" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "register_session_id" UUID NOT NULL,
  "kind" "RegisterCashMovementKind" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "register_cash_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "register_cash_movements_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "register_cash_movements_register_session_id_fkey"
    FOREIGN KEY ("register_session_id") REFERENCES "register_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "register_cash_movements_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "register_cash_movements_tenant_id_register_session_id_created_at_idx"
  ON "register_cash_movements"("tenant_id", "register_session_id", "created_at");
