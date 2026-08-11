-- Universal POS: per-tenant BUSINESS_CONFIG (JSON-driven verticals)
-- ERD: BUSINESS ||--|| BUSINESS_CONFIG ; ITEM/ORDERS.extra_fields = products.meta / orders.meta

CREATE TABLE IF NOT EXISTS "business_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_type" VARCHAR(40) NOT NULL,
    "item_fields" JSONB NOT NULL DEFAULT '[]',
    "order_fields" JSONB NOT NULL DEFAULT '[]',
    "ui_flow" JSONB NOT NULL DEFAULT '{}',
    "billing" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_configs_tenant_id_key"
  ON "business_configs"("tenant_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_configs_tenant_id_fkey'
  ) THEN
    ALTER TABLE "business_configs"
      ADD CONSTRAINT "business_configs_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
