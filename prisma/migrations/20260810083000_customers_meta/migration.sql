-- Align customers table with Prisma model (meta JSON bag; event dates stored in meta).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "meta" JSONB NOT NULL DEFAULT '{}';

-- Preserve legacy event_date values into meta.eventDate (YYYY-MM-DD)
UPDATE "customers"
SET "meta" = COALESCE("meta", '{}'::jsonb) || jsonb_build_object(
  'eventDate',
  to_char("event_date", 'YYYY-MM-DD')
)
WHERE "event_date" IS NOT NULL
  AND (
    "meta" IS NULL
    OR NOT ("meta" ? 'eventDate')
  );
