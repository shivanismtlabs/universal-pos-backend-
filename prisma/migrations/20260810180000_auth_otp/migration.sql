-- Email OTP recovery (forgot password / forgot PIN)
CREATE TABLE IF NOT EXISTS "auth_otp_challenges" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "target_user_id" UUID,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_otp_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "auth_otp_challenges_email_purpose_created_at_idx"
  ON "auth_otp_challenges"("email", "purpose", "created_at");
