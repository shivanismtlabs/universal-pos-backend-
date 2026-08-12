-- Sales depth: gift cards, loyalty points, gift_card payment method
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'gift_card';

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "loyalty_points" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "gift_cards" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "initial_value" DECIMAL(12,2) NOT NULL,
  "balance" DECIMAL(12,2) NOT NULL,
  "currency_code" CHAR(3) NOT NULL DEFAULT 'INR',
  "customer_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMPTZ(6),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_tenant_id_code_key"
  ON "gift_cards"("tenant_id", "code");
CREATE INDEX IF NOT EXISTS "gift_cards_tenant_id_status_idx"
  ON "gift_cards"("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "gift_card_txns" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "gift_card_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "balance_after" DECIMAL(12,2) NOT NULL,
  "order_id" UUID,
  "note" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_card_txns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gift_card_txns_tenant_id_gift_card_id_idx"
  ON "gift_card_txns"("tenant_id", "gift_card_id");

CREATE TABLE IF NOT EXISTS "loyalty_ledger" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "order_id" UUID,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "loyalty_ledger_tenant_id_customer_id_created_at_idx"
  ON "loyalty_ledger"("tenant_id", "customer_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "gift_card_txns" ADD CONSTRAINT "gift_card_txns_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "gift_card_txns" ADD CONSTRAINT "gift_card_txns_gift_card_id_fkey"
    FOREIGN KEY ("gift_card_id") REFERENCES "gift_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
