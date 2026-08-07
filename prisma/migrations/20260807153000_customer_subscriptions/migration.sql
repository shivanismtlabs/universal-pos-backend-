-- AlterEnum
DO $$ BEGIN
  ALTER TYPE "OrderKind" ADD VALUE 'subscription';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CustomerSubscriptionStatus" AS ENUM ('active', 'paused', 'cancelled', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "customer_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" "CustomerSubscriptionStatus" NOT NULL DEFAULT 'active',
    "billing_period_days" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "last_order_id" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_subscriptions_tenant_id_status_idx" ON "customer_subscriptions"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "customer_subscriptions_tenant_id_customer_id_idx" ON "customer_subscriptions"("tenant_id", "customer_id");
CREATE INDEX IF NOT EXISTS "customer_subscriptions_tenant_id_product_id_idx" ON "customer_subscriptions"("tenant_id", "product_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
