-- Enforce max SKU length at DB (required columns stay NOT NULL).
-- Existing rows shorter than 15 remain valid; new creates are validated 15–18 in the API.

ALTER TABLE "products" ALTER COLUMN "sku_code" TYPE VARCHAR(18);
ALTER TABLE "stock_levels" ALTER COLUMN "sku" TYPE VARCHAR(18);
