# Legacy rental schema → Universal Business OS mapping

Use with `schema.rental-legacy.prisma` (backup) and new `schema.prisma`.

| Legacy table / concept | New table | Notes |
|------------------------|-----------|--------|
| `tenants` | `tenants` | + currency, locale, timezone, tax_mode; `gstin` → `tax_id` |
| `stores` | `locations` | `type=store`; `state_code` → `region_code` |
| — | `organizations` | Optional legal entity |
| — | `departments`, `teams`, `memberships`, `employees` | Org/HR foundation |
| — | `modules`, `tenant_modules` | Industry packs |
| `users` | `users` | `primary_store_id` → `primary_location_id` |
| `roles` / `permissions` / `user_roles` | same | + `permissions.module_code` |
| `customers` | `customers` | Wedding `event_date` → meta or rental party |
| `customer_measurements` | `mod_rental_measurements` | Rental module only |
| `parties` / `party_members` | `mod_rental_parties` / `mod_rental_party_members` | |
| `categories` | `categories` | + optional parent |
| `product_styles` | `products` | `style_code` → `sku_code`; `is_rental` → `fulfillment_mode=rental` |
| `inventory_units` | `stock_units` | `size` → `variant_label`; `rental_price` → product.base_price / price book later |
| `retail_skus` | `stock_levels` | Qty commerce |
| `unit_reservations` | `stock_reservations` | |
| `inventory_movements` | `stock_movements` | |
| `rental_orders` | `orders` + `mod_rental_orders` | Core money + rental dates/lifecycle |
| `order_items` | `order_items` | `item_type` → `item_kind` |
| `appointments` | `appointments` | `type` now free string |
| `cleaning_jobs` | `mod_rental_cleaning_jobs` | |
| `damage_records` | `mod_rental_damage_records` | |
| `order_fees` | `order_fees` | `fee_type` → `fee_code` |
| `invoices` | `invoices` | + `tax_breakdown` JSON |
| — | `register_sessions` | POS till open/close |
| — | `custom_field_*` | Unknown industry fields |
| — | `outbox_events` | Event-driven hook |

## Apply strategy (dev)

1. Keep demo data? → dump, then reset DB and `prisma migrate` / `db push`.
2. NestJS still points at legacy names → **do not push this schema to production demo until API rewrite (Phase 2)**.
3. This branch (`feature/universal-pos`) is the **design source of truth**.

## Module seed (suggested codes)

`core`, `iam`, `catalog`, `inventory`, `orders`, `pos`, `payments`, `tax`, `documents`, `notify`, `rental`, `appointments`, `suppliers`, `reports`
