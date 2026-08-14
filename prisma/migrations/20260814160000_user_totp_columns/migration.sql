-- User 2FA columns (were in Prisma schema but never applied on production)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret_enc" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_backup_hashes" JSONB NOT NULL DEFAULT '[]'::jsonb;
