-- BusinessGroup enterprise layer. Tenant isolation unchanged.
-- Additive only — existing tenants keep working with null business_group_id.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "business_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "share_inventory" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "share_suppliers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "share_customers" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "business_groups" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "owner_identity_id" UUID NOT NULL,
  "entitlements" JSONB NOT NULL DEFAULT '[]',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_groups_slug_key" ON "business_groups"("slug");
CREATE INDEX IF NOT EXISTS "business_groups_owner_identity_id_idx" ON "business_groups"("owner_identity_id");

CREATE TABLE IF NOT EXISTS "business_group_memberships" (
  "id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_group_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_group_memberships_group_id_identity_id_key"
  ON "business_group_memberships"("group_id", "identity_id");
CREATE INDEX IF NOT EXISTS "business_group_memberships_identity_id_idx"
  ON "business_group_memberships"("identity_id");

CREATE TABLE IF NOT EXISTS "approval_policies" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID,
  "type" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "approval_policies_business_group_id_type_idx"
  ON "approval_policies"("business_group_id", "type");
CREATE INDEX IF NOT EXISTS "approval_policies_tenant_id_type_idx"
  ON "approval_policies"("tenant_id", "type");

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "requested_by_id" UUID,
  "resolved_by_id" UUID,
  "amount" DECIMAL(14, 2),
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "current_step" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "approval_requests_tenant_id_status_created_at_idx"
  ON "approval_requests"("tenant_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "approval_requests_business_group_id_status_created_at_idx"
  ON "approval_requests"("business_group_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "approval_steps" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "step_index" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "actor_id" UUID,
  "note" TEXT,
  "acted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "approval_steps_request_id_step_index_idx"
  ON "approval_steps"("request_id", "step_index");

CREATE TABLE IF NOT EXISTS "exception_alert_rules" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID,
  "type" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "threshold" DECIMAL(14, 4),
  "cooldown_minutes" INTEGER NOT NULL DEFAULT 360,
  "recipients" JSONB NOT NULL DEFAULT '{}',
  "last_fired_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exception_alert_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "exception_alert_rules_business_group_id_type_idx"
  ON "exception_alert_rules"("business_group_id", "type");

CREATE TABLE IF NOT EXISTS "intercompany_transfers" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "source_tenant_id" UUID NOT NULL,
  "destination_tenant_id" UUID NOT NULL,
  "source_location_id" UUID NOT NULL,
  "destination_location_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "notes" TEXT,
  "created_by_id" UUID,
  "approved_by_id" UUID,
  "issued_at" TIMESTAMPTZ(6),
  "received_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intercompany_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "intercompany_transfers_business_group_id_status_created_at_idx"
  ON "intercompany_transfers"("business_group_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "intercompany_transfers_source_tenant_id_created_at_idx"
  ON "intercompany_transfers"("source_tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "intercompany_transfers_destination_tenant_id_created_at_idx"
  ON "intercompany_transfers"("destination_tenant_id", "created_at");

CREATE TABLE IF NOT EXISTS "intercompany_transfer_lines" (
  "id" UUID NOT NULL,
  "transfer_id" UUID NOT NULL,
  "sku" VARCHAR(18) NOT NULL,
  "name" TEXT NOT NULL,
  "source_product_id" UUID,
  "dest_product_id" UUID,
  "quantity" DECIMAL(12, 3) NOT NULL,
  "unit_cost" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "tax_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  CONSTRAINT "intercompany_transfer_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "intercompany_transfer_lines_transfer_id_idx"
  ON "intercompany_transfer_lines"("transfer_id");

CREATE TABLE IF NOT EXISTS "business_spin_offs" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requested_by_identity_id" UUID NOT NULL,
  "export_payload" JSONB NOT NULL DEFAULT '{}',
  "confirmation" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "business_spin_offs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "business_spin_offs_business_group_id_status_idx"
  ON "business_spin_offs"("business_group_id", "status");

CREATE TABLE IF NOT EXISTS "group_supplier_links" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "phone" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_supplier_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_supplier_links_business_group_id_tenant_id_supplier_id_key"
  ON "group_supplier_links"("business_group_id", "tenant_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "group_supplier_links_business_group_id_display_name_idx"
  ON "group_supplier_links"("business_group_id", "display_name");

CREATE TABLE IF NOT EXISTS "group_customer_links" (
  "id" UUID NOT NULL,
  "business_group_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "match_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_customer_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_customer_links_business_group_id_tenant_id_customer_id_key"
  ON "group_customer_links"("business_group_id", "tenant_id", "customer_id");
CREATE INDEX IF NOT EXISTS "group_customer_links_business_group_id_match_key_idx"
  ON "group_customer_links"("business_group_id", "match_key");

-- FKs (IF NOT EXISTS via DO blocks for re-run safety)
DO $$ BEGIN
  ALTER TABLE "business_groups"
    ADD CONSTRAINT "business_groups_owner_identity_id_fkey"
    FOREIGN KEY ("owner_identity_id") REFERENCES "identity_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "tenants_business_group_id_idx" ON "tenants"("business_group_id");

DO $$ BEGIN
  ALTER TABLE "business_group_memberships"
    ADD CONSTRAINT "business_group_memberships_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "business_group_memberships"
    ADD CONSTRAINT "business_group_memberships_identity_id_fkey"
    FOREIGN KEY ("identity_id") REFERENCES "identity_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_policies"
    ADD CONSTRAINT "approval_policies_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_policies"
    ADD CONSTRAINT "approval_policies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "exception_alert_rules"
    ADD CONSTRAINT "exception_alert_rules_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "exception_alert_rules"
    ADD CONSTRAINT "exception_alert_rules_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfers"
    ADD CONSTRAINT "intercompany_transfers_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfers"
    ADD CONSTRAINT "intercompany_transfers_source_tenant_id_fkey"
    FOREIGN KEY ("source_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfers"
    ADD CONSTRAINT "intercompany_transfers_destination_tenant_id_fkey"
    FOREIGN KEY ("destination_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfers"
    ADD CONSTRAINT "intercompany_transfers_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfers"
    ADD CONSTRAINT "intercompany_transfers_approved_by_id_fkey"
    FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "intercompany_transfer_lines"
    ADD CONSTRAINT "intercompany_transfer_lines_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "intercompany_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "business_spin_offs"
    ADD CONSTRAINT "business_spin_offs_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "business_spin_offs"
    ADD CONSTRAINT "business_spin_offs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_supplier_links"
    ADD CONSTRAINT "group_supplier_links_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_supplier_links"
    ADD CONSTRAINT "group_supplier_links_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_customer_links"
    ADD CONSTRAINT "group_customer_links_business_group_id_fkey"
    FOREIGN KEY ("business_group_id") REFERENCES "business_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_customer_links"
    ADD CONSTRAINT "group_customer_links_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
