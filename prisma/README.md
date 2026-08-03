# Database (Prisma + PostgreSQL)

Source ERD: [`../../docs/erd/walit-pos-erd.mmd`](../../docs/erd/walit-pos-erd.mmd)

| Artifact | Purpose |
|----------|---------|
| `schema.prisma` | Prisma models = ERD tables |
| `migrations/0_init/migration.sql` | Full Postgres DDL (38 tables + enums + FKs + reservation overlap) |
| `sql/001_reservation_exclusion.sql` | Standalone overlap constraint if already pushed |
| `sql/000_init_from_erd.sql` | Same as init migration (convenience copy) |

## Apply to local Postgres (no Docker)

1. pgAdmin → **PostgreSQL 18** → Databases → right-click → **Create** → name: `walit_pos`
2. Set `.env`:
   `DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/walit_pos`
3. From `backend/`:
   ```bash
   npx prisma db push
   ```
4. In pgAdmin Query Tool on `walit_pos`, run `prisma/sql/001_reservation_exclusion.sql`
   (first line needs `CREATE EXTENSION IF NOT EXISTS btree_gist;`)

Do **not** use another app's DB (e.g. `linkgram_local1`).

## ERD → table map

All ERD entities are in `schema.prisma`: tenants, stores, plans, subscriptions, flags, users/RBAC, audit, customers/measurements/parties, categories/styles/units/reservations/movements, retail, suppliers/POs, orders/items/payments/invoices/fees/layaway, appointments, returns/cleaning/damage, documents, notifications, webhooks, api_keys, offline_sync.
