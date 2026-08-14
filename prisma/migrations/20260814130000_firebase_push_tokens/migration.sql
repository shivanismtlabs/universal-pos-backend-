-- Firebase / FCM device tokens
CREATE TABLE IF NOT EXISTS "device_push_tokens" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "platform" VARCHAR(16) NOT NULL DEFAULT 'web',
  "user_agent" VARCHAR(500),
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "device_push_tokens_tenant_token_key" UNIQUE ("tenant_id", "token")
);

CREATE INDEX IF NOT EXISTS "device_push_tokens_tenant_user_active_idx"
  ON "device_push_tokens" ("tenant_id", "user_id", "is_active");

ALTER TABLE "device_push_tokens"
  ADD CONSTRAINT "device_push_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "device_push_tokens"
  ADD CONSTRAINT "device_push_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
