-- Speed customer book search / newest-first lists as volume grows
CREATE INDEX IF NOT EXISTS "customers_tenant_id_created_at_idx" ON "customers"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "customers_tenant_id_full_name_idx" ON "customers"("tenant_id", "full_name");
