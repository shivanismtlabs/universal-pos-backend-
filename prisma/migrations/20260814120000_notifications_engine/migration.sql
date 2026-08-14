-- Notifications engine: in-app inbox + per-user prefs
DO $$ BEGIN
  ALTER TYPE "NotificationChannel" ADD VALUE 'in_app';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "app_notifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "location_id" UUID,
  "type" VARCHAR(64) NOT NULL,
  "severity" VARCHAR(16) NOT NULL DEFAULT 'info',
  "status" VARCHAR(16) NOT NULL DEFAULT 'unread',
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "href" VARCHAR(500),
  "dedupe_key" VARCHAR(191),
  "group_key" VARCHAR(191),
  "payload" JSONB NOT NULL DEFAULT '{}',
  "read_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "app_notifications_tenant_user_status_created_idx"
  ON "app_notifications" ("tenant_id", "user_id", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "app_notifications_tenant_type_location_idx"
  ON "app_notifications" ("tenant_id", "type", "location_id");

CREATE UNIQUE INDEX IF NOT EXISTS "app_notifications_tenant_user_dedupe_active_uidx"
  ON "app_notifications" ("tenant_id", "user_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('unread', 'read') AND "resolved_at" IS NULL;

ALTER TABLE "app_notifications"
  ADD CONSTRAINT "app_notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_notifications"
  ADD CONSTRAINT "app_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_notifications"
  ADD CONSTRAINT "app_notifications_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "user_notification_preferences" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "type" VARCHAR(64) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "in_app" BOOLEAN NOT NULL DEFAULT TRUE,
  "email" BOOLEAN NOT NULL DEFAULT FALSE,
  "push" BOOLEAN NOT NULL DEFAULT FALSE,
  "sms" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_notification_preferences_tenant_user_type_key"
    UNIQUE ("tenant_id", "user_id", "type")
);

ALTER TABLE "user_notification_preferences"
  ADD CONSTRAINT "user_notification_preferences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_notification_preferences"
  ADD CONSTRAINT "user_notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
