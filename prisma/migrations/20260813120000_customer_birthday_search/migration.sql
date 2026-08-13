-- AlterTable
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "date_of_birth" DATE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customers_tenant_id_date_of_birth_idx" ON "customers"("tenant_id", "date_of_birth");
