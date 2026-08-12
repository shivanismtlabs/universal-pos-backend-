-- Manual attendance fields + CRM ledgers + GRN/AP + barcode type + pay methods

-- ── Attendance ──────────────────────────────────────────────────────────────
ALTER TABLE "attendance_entries"
  ALTER COLUMN "clock_in_at" DROP NOT NULL;

ALTER TABLE "attendance_entries"
  ADD COLUMN IF NOT EXISTS "work_date" DATE,
  ADD COLUMN IF NOT EXISTS "shift_id" UUID,
  ADD COLUMN IF NOT EXISTS "break_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'present';

UPDATE "attendance_entries"
SET "work_date" = ("clock_in_at" AT TIME ZONE 'UTC')::date
WHERE "work_date" IS NULL AND "clock_in_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "attendance_entries_tenant_id_user_id_work_date_idx"
  ON "attendance_entries"("tenant_id", "user_id", "work_date");
CREATE INDEX IF NOT EXISTS "attendance_entries_tenant_id_work_date_status_idx"
  ON "attendance_entries"("tenant_id", "work_date", "status");

DO $$ BEGIN
  ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "work_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Product barcode type ────────────────────────────────────────────────────
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "barcode_type" VARCHAR(16);

-- ── Payment methods ─────────────────────────────────────────────────────────
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'wallet';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'qr';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'emi';

-- ── Customer CRM ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "store_credit_ledger" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "balance_after" DECIMAL(12,2) NOT NULL,
  "order_id" UUID,
  "note" TEXT,
  "actor_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_credit_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "store_credit_ledger_tenant_id_customer_id_created_at_idx"
  ON "store_credit_ledger"("tenant_id", "customer_id", "created_at");

CREATE TABLE IF NOT EXISTS "customer_notes" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "customer_notes_tenant_id_customer_id_created_at_idx"
  ON "customer_notes"("tenant_id", "customer_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "store_credit_ledger" ADD CONSTRAINT "store_credit_ledger_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_ledger" ADD CONSTRAINT "store_credit_ledger_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_ledger" ADD CONSTRAINT "store_credit_ledger_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Purchases: GRN + supplier AP ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "goods_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "purchase_order_id" UUID NOT NULL,
  "grn_number" TEXT NOT NULL,
  "notes" TEXT,
  "actor_user_id" UUID,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "goods_receipts_tenant_id_grn_number_key"
  ON "goods_receipts"("tenant_id", "grn_number");
CREATE INDEX IF NOT EXISTS "goods_receipts_tenant_id_supplier_id_received_at_idx"
  ON "goods_receipts"("tenant_id", "supplier_id", "received_at");

CREATE TABLE IF NOT EXISTS "goods_receipt_lines" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "goods_receipt_id" UUID NOT NULL,
  "stock_level_id" UUID NOT NULL,
  "purchase_order_line_id" UUID,
  "qty" DECIMAL(12,3) NOT NULL,
  "unit_cost" DECIMAL(12,2),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "goods_receipt_lines_tenant_id_goods_receipt_id_idx"
  ON "goods_receipt_lines"("tenant_id", "goods_receipt_id");

CREATE TABLE IF NOT EXISTS "supplier_invoices" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "purchase_order_id" UUID,
  "goods_receipt_id" UUID,
  "invoice_number" TEXT NOT NULL,
  "invoice_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "due_date" DATE,
  "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "grand_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'open',
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoices_tenant_id_invoice_number_key"
  ON "supplier_invoices"("tenant_id", "invoice_number");
CREATE INDEX IF NOT EXISTS "supplier_invoices_tenant_id_supplier_id_status_idx"
  ON "supplier_invoices"("tenant_id", "supplier_id", "status");
CREATE INDEX IF NOT EXISTS "supplier_invoices_tenant_id_due_date_idx"
  ON "supplier_invoices"("tenant_id", "due_date");

CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "supplier_invoice_id" UUID,
  "amount" DECIMAL(12,2) NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'bank_transfer',
  "reference" TEXT,
  "notes" TEXT,
  "actor_user_id" UUID,
  "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "supplier_payments_tenant_id_supplier_id_paid_at_idx"
  ON "supplier_payments"("tenant_id", "supplier_id", "paid_at");

DO $$ BEGIN
  ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_fkey"
    FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_stock_level_id_fkey"
    FOREIGN KEY ("stock_level_id") REFERENCES "stock_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_fkey"
    FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_goods_receipt_id_fkey"
    FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_invoice_id_fkey"
    FOREIGN KEY ("supplier_invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
