-- Expense management harden + petty cash fund (P2.6c)

ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "parent_id" UUID;
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "receipt_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "account_code" TEXT;
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "expense_categories_tenant_id_is_active_idx"
  ON "expense_categories"("tenant_id", "is_active");

DO $$ BEGIN
  ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "expense_number" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "net_amount" DECIMAL(12,2);
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tax_rate_percent" DECIMAL(6,3);
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tax_inclusive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "payee" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reference" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "is_reimbursement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

-- Prefer pending for new rows going forward (existing default may stay approved)
ALTER TABLE "expenses" ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS "expenses_tenant_id_idempotency_key_key"
  ON "expenses"("tenant_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "expenses_tenant_id_expense_number_idx"
  ON "expenses"("tenant_id", "expense_number");

CREATE TABLE IF NOT EXISTS "petty_cash_funds" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "location_id" UUID,
  "name" TEXT NOT NULL DEFAULT 'Petty cash',
  "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "petty_cash_funds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "petty_cash_funds_tenant_id_location_id_key"
  ON "petty_cash_funds"("tenant_id", "location_id");

CREATE TABLE IF NOT EXISTS "petty_cash_ledger_entries" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "fund_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "balance_after" DECIMAL(12,2) NOT NULL,
  "expense_id" UUID,
  "reference" TEXT,
  "notes" TEXT,
  "actor_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "petty_cash_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "petty_cash_ledger_entries_tenant_id_fund_id_created_at_idx"
  ON "petty_cash_ledger_entries"("tenant_id", "fund_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_ledger_entries" ADD CONSTRAINT "petty_cash_ledger_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_ledger_entries" ADD CONSTRAINT "petty_cash_ledger_entries_fund_id_fkey"
    FOREIGN KEY ("fund_id") REFERENCES "petty_cash_funds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "petty_cash_ledger_entries" ADD CONSTRAINT "petty_cash_ledger_entries_expense_id_fkey"
    FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
