-- Supplier master (generic procurement — any vertical)
CREATE TYPE "SupplierStatus" AS ENUM ('active', 'inactive', 'blocked', 'on_hold', 'archived');

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "code" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "legal_name" TEXT,
  ADD COLUMN IF NOT EXISTS "supplier_type" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "category" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "status" "SupplierStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "designation" TEXT,
  ADD COLUMN IF NOT EXISTS "phone_alt" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "website" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "tax_id" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "tax_category" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "registration_no" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "payment_term" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "due_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "credit_limit" DECIMAL(14, 2),
  ADD COLUMN IF NOT EXISTS "currency_code" CHAR(3),
  ADD COLUMN IF NOT EXISTS "preferred_pay_method" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "bank_name" TEXT,
  ADD COLUMN IF NOT EXISTS "bank_account_name" TEXT,
  ADD COLUMN IF NOT EXISTS "bank_account_no" TEXT,
  ADD COLUMN IF NOT EXISTS "bank_identifier" TEXT,
  ADD COLUMN IF NOT EXISTS "pay_handle" TEXT;

UPDATE "suppliers" s
SET "code" = 'SUP-' || LPAD(sub.rn::text, 6, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
  FROM "suppliers"
) sub
WHERE s.id = sub.id AND (s.code IS NULL OR s.code = '');

ALTER TABLE "suppliers" ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_tenant_id_code_key" ON "suppliers"("tenant_id", "code");
CREATE INDEX IF NOT EXISTS "suppliers_tenant_id_status_idx" ON "suppliers"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "suppliers_tenant_id_name_idx" ON "suppliers"("tenant_id", "name");

CREATE TABLE IF NOT EXISTS "supplier_contacts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "role" VARCHAR(80),
  "notes" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "supplier_addresses" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "kind" VARCHAR(24) NOT NULL DEFAULT 'billing',
  "line1" TEXT NOT NULL,
  "line2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postal_code" TEXT,
  "country" TEXT,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "supplier_addresses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "supplier_documents" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "doc_type" VARCHAR(64) NOT NULL,
  "file_url" TEXT NOT NULL,
  "file_name" TEXT,
  "notes" TEXT,
  "uploaded_by" UUID,
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "supplier_notes" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "actor_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_notes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_addresses" ADD CONSTRAINT "supplier_addresses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_addresses" ADD CONSTRAINT "supplier_addresses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "supplier_contacts_tenant_id_supplier_id_idx" ON "supplier_contacts"("tenant_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_addresses_tenant_id_supplier_id_idx" ON "supplier_addresses"("tenant_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_documents_tenant_id_supplier_id_idx" ON "supplier_documents"("tenant_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_notes_tenant_id_supplier_id_created_at_idx" ON "supplier_notes"("tenant_id", "supplier_id", "created_at");
