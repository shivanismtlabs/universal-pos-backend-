-- Product Management: brands, catalog enrich, variants, bundles, batches

-- ProductKind + status
ALTER TYPE "ProductKind" ADD VALUE IF NOT EXISTS 'rental';

DO $$ BEGIN
  CREATE TYPE "ProductStatus" AS ENUM ('active', 'inactive', 'draft', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "brands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "brands_tenant_id_name_key" ON "brands"("tenant_id", "name");
CREATE INDEX IF NOT EXISTS "brands_tenant_id_is_active_idx" ON "brands"("tenant_id", "is_active");

ALTER TABLE "brands" DROP CONSTRAINT IF EXISTS "brands_tenant_id_fkey";
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Category enrich
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");

-- Product enrich
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "brand_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "barcode" VARCHAR(64);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "qr_code" VARCHAR(255);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "internal_code" VARCHAR(64);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "status" "ProductStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_description" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cost_price" DECIMAL(12,2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "mrp" DECIMAL(12,2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unit_of_measure" VARCHAR(16) NOT NULL DEFAULT 'pcs';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "track_batch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "can_sell" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "can_purchase" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "available_in_pos" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "updated_by_id" UUID;

CREATE INDEX IF NOT EXISTS "products_tenant_id_status_idx" ON "products"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "products_tenant_id_brand_id_idx" ON "products"("tenant_id", "brand_id");
CREATE INDEX IF NOT EXISTS "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");
CREATE INDEX IF NOT EXISTS "products_tenant_id_barcode_idx" ON "products"("tenant_id", "barcode");

ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_brand_id_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Variants
CREATE TABLE IF NOT EXISTS "product_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku_code" VARCHAR(18) NOT NULL,
    "barcode" VARCHAR(64),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "base_price" DECIMAL(12,2),
    "cost_price" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_tenant_id_sku_code_key" ON "product_variants"("tenant_id", "sku_code");
CREATE INDEX IF NOT EXISTS "product_variants_tenant_id_product_id_idx" ON "product_variants"("tenant_id", "product_id");
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_tenant_id_fkey";
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_product_id_fkey";
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bundle lines
CREATE TABLE IF NOT EXISTS "product_bundle_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bundle_product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "component_variant_id" UUID,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_bundle_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_bundle_lines_bundle_product_id_component_product_id_component_variant_id_key"
  ON "product_bundle_lines"("bundle_product_id", "component_product_id", "component_variant_id");
CREATE INDEX IF NOT EXISTS "product_bundle_lines_tenant_id_bundle_product_id_idx" ON "product_bundle_lines"("tenant_id", "bundle_product_id");
ALTER TABLE "product_bundle_lines" DROP CONSTRAINT IF EXISTS "product_bundle_lines_tenant_id_fkey";
ALTER TABLE "product_bundle_lines" ADD CONSTRAINT "product_bundle_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_bundle_lines" DROP CONSTRAINT IF EXISTS "product_bundle_lines_bundle_product_id_fkey";
ALTER TABLE "product_bundle_lines" ADD CONSTRAINT "product_bundle_lines_bundle_product_id_fkey" FOREIGN KEY ("bundle_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_bundle_lines" DROP CONSTRAINT IF EXISTS "product_bundle_lines_component_product_id_fkey";
ALTER TABLE "product_bundle_lines" ADD CONSTRAINT "product_bundle_lines_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Batches
CREATE TABLE IF NOT EXISTS "product_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "location_id" UUID NOT NULL,
    "batch_code" VARCHAR(64) NOT NULL,
    "manufactured_at" DATE,
    "expires_at" DATE,
    "qty_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_batches_tenant_id_location_id_product_id_batch_code_key"
  ON "product_batches"("tenant_id", "location_id", "product_id", "batch_code");
CREATE INDEX IF NOT EXISTS "product_batches_tenant_id_product_id_idx" ON "product_batches"("tenant_id", "product_id");
CREATE INDEX IF NOT EXISTS "product_batches_tenant_id_expires_at_idx" ON "product_batches"("tenant_id", "expires_at");
ALTER TABLE "product_batches" DROP CONSTRAINT IF EXISTS "product_batches_tenant_id_fkey";
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_batches" DROP CONSTRAINT IF EXISTS "product_batches_product_id_fkey";
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_batches" DROP CONSTRAINT IF EXISTS "product_batches_variant_id_fkey";
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_batches" DROP CONSTRAINT IF EXISTS "product_batches_location_id_fkey";
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Serial units → variant link
ALTER TABLE "stock_units" ADD COLUMN IF NOT EXISTS "product_variant_id" UUID;
CREATE INDEX IF NOT EXISTS "stock_units_tenant_id_product_id_idx" ON "stock_units"("tenant_id", "product_id");
ALTER TABLE "stock_units" DROP CONSTRAINT IF EXISTS "stock_units_product_variant_id_fkey";
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
