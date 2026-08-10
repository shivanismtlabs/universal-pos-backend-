-- Zoho-style global identity + multi-org membership
CREATE TABLE IF NOT EXISTS "identity_accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "google_sub" TEXT,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "refresh_token_hash" TEXT,
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "identity_accounts_email_key" ON "identity_accounts"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "identity_accounts_google_sub_key" ON "identity_accounts"("google_sub");

CREATE TABLE IF NOT EXISTS "identity_tenant_memberships" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_tenant_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "identity_tenant_memberships_user_id_key"
  ON "identity_tenant_memberships"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "identity_tenant_memberships_identity_id_tenant_id_key"
  ON "identity_tenant_memberships"("identity_id", "tenant_id");
CREATE INDEX IF NOT EXISTS "identity_tenant_memberships_identity_id_idx"
  ON "identity_tenant_memberships"("identity_id");

DO $$ BEGIN
  ALTER TABLE "identity_tenant_memberships"
    ADD CONSTRAINT "identity_tenant_memberships_identity_id_fkey"
    FOREIGN KEY ("identity_id") REFERENCES "identity_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "identity_tenant_memberships"
    ADD CONSTRAINT "identity_tenant_memberships_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "identity_tenant_memberships"
    ADD CONSTRAINT "identity_tenant_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
