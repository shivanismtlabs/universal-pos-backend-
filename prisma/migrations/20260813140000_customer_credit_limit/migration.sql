-- Customer credit limit for partial/credit sales (null = unlimited)
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "credit_limit" DECIMAL(12,2);
