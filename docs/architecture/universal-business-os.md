# Universal Business Operating System (UBOS)

**Branch:** `feature/universal-pos`  
**Product framing:** Multi-tenant modular **Business Operating System** — POS is one module, not the whole product.  
**Inspiration:** Shopify (commerce core) + Odoo (apps) + Salesforce (metadata) — not a tuxedo-only POS.

---

## 1. Honest architect position (read first)

Your prompt asks for Shopify + NetSuite + Dynamics + Salesforce in one design. That is the **north star**, not the day-1 schema dump.

| Reality | Decision |
|---------|----------|
| 100k tenants, every industry, ABAC, SSO, payroll, manufacturing MRP… | Multi-year platform |
| “No issues / every unknown case covered” | Impossible as hardcode — only possible via **modules + metadata** |
| Legacy rental vertical | Becomes **Rental capability pack** on top of Core |

**What we design now (Phase 1 DB):**  
Industry-agnostic **Core** + **Module registry** + **Org/IAM foundation** + **Commerce engine** (catalog, stock, orders, payments, tax, POS checkout) + **Rental module extension tables** (preserve today’s logic).

**What we do NOT put in Core:** salon chair logic, hospital beds, kitchen KOT, pharmacy schedules — those are installable modules later.

---

## 2. Guiding principles

1. **Core never knows the industry** — only generic nouns: Tenant, Location, Product, Order, Payment, Party (customer/patient/guest).
2. **Industry = module** — install/enable per tenant; remove without rewriting Core.
3. **Metadata over columns** — custom fields, statuses, forms, nav come from config when industries diverge.
4. **Reuse our rental logic** — move pickup/return/cleaning/damage/measurements into `mod_rental_*` (and booking), not delete the ideas.
5. **Modular monolith** — Nest modules map 1:1 to DB bounded contexts; extract microservices later if needed.
6. **Shared DB + `tenant_id`** — every business row scoped; RLS later optional.

---

## 3. Capability layers

```text
┌─────────────────────────────────────────────────────────────┐
│  PLATFORM  (super-admin, plans, billing, module marketplace) │
├─────────────────────────────────────────────────────────────┤
│  CORE IAM + ORG  (tenants, orgs, locations, users, RBAC)     │
├─────────────────────────────────────────────────────────────┤
│  CORE COMMERCE   (catalog, stock, orders, pay, tax, POS)     │
├─────────────────────────────────────────────────────────────┤
│  CORE ENGINES    (docs, notify, audit, sync, search, files)  │
├─────────────────────────────────────────────────────────────┤
│  INDUSTRY MODULES (rental, retail+, salon, …)  ← plugins     │
└─────────────────────────────────────────────────────────────┘
```

**POS** = checkout + register session + receipt against a generic `orders` row.  
Same POS works for grocery sale, tuxedo rental deposit, salon bill — line types differ, engine does not.

---

## 4. Organization hierarchy (pragmatic enterprise)

Full Salesforce-depth trees kill small shops. We use **optional depth**:

```text
Platform
  └── Tenant                    ← SaaS customer / billing boundary (REQUIRED)
        └── Organization        ← legal entity / brand (OPTIONAL; default = 1)
              └── Location      ← store | branch | warehouse | clinic | kitchen
                    └── Department / Team (OPTIONAL)
                          └── Membership (User ↔ Location/Dept + Role)
```

| Level | Why it exists | Small shop | Enterprise |
|-------|---------------|------------|------------|
| Tenant | Isolation + subscription | 1 | 1 |
| Organization | Multi-company GST / legal | skip (null) | many |
| Location | Where stock/sales happen | 1 store | 50+ |
| Department/Team | Ops grouping | skip | HR/ops |
| Role + scope | Access | admin/cashier | custom + store-scoped |

**Rule:** Every transactional row has `tenant_id` + usually `location_id`.  
Branch manager = role scoped to location(s) via `memberships` / `user_roles.location_id`.

---

## 5. Module system

### Catalog (platform-defined)

`modules` — code, name, depends_on[], nav_schema, permission_codes[]

### Tenant install

`tenant_modules` — tenant_id, module_code, status (installed|enabled|disabled), config JSON

**Example**

| Tenant | Enabled modules |
|--------|-----------------|
| Formal rental shop | `core`, `catalog`, `inventory`, `orders`, `pos`, `payments`, `rental`, `appointments`, `whatsapp` |
| Grocery | `core`, `catalog`, `inventory`, `orders`, `pos`, `payments`, `retail_qty` |
| Salon | `core`, `catalog`, `orders`, `pos`, `payments`, `appointments`, `services` |

Dynamic sidebar / routes / API guards read `tenant_modules` + plan features + user permissions.

---

## 6. Domain model (Core nouns)

| Concept | Meaning | Not industry-specific |
|---------|---------|------------------------|
| Party / Customer | Who we serve | patient, guest, member = same table + labels |
| Product | What we sell/rent/book | SKU / service / rental asset class |
| Stock unit | Serialized asset | tuxedo piece, camera body, bike |
| Stock level | Qty on hand | grocery, accessories |
| Order | Commercial commitment | sale, rental, service ticket |
| Order line | Line with type | product / service / rental_unit / fee |
| Payment | Money movement | cash/card/UPI/gateway |
| Invoice | Tax document | GST/VAT/none via tax engine config |
| Appointment | Time booking | fitting, haircut, doctor slot |
| Document | Files | agreement, Rx, ID |
| Custom field | Extensibility | measurements, Rx notes, table number |

---

## 7. How current rental maps → Universal

| Legacy (today) | Universal Core / Module |
|----------------|-------------------------|
| `tenants` | `tenants` + locale/currency/tax_profile |
| `stores` | `locations` (type=store) |
| `users` / `roles` | `users` + `employees` profile + scoped roles |
| `customers` | `customers` (party) — drop hardwired wedding fields to custom/rental ext |
| `customer_measurements` | `mod_rental_measurements` OR custom_field_values |
| `parties` / members | `mod_rental_parties` (event groups) |
| `categories` / `product_styles` | `categories` / `products` |
| `inventory_units` | `stock_units` (serialized) + rental price in module/price book |
| `retail_skus` | `stock_levels` |
| `rental_orders` | `orders` + `mod_rental_orders` (pickup/return/event) |
| `order_items` | `order_items` (generic item_kind) |
| `appointments` | `appointments` (type free-form / module) |
| cleaning / damage | `mod_rental_cleaning_jobs`, `mod_rental_damage_records` |
| `feature_flags` | keep + `tenant_modules` |

**Core does not contain** `fitted` tuxedo statuses as the only order machine — Core has generic statuses; rental module defines its status graph in config.

---

## 8. Tax / money / locale (multi-country ready)

On `tenants.settings` / dedicated columns:

- `currency_code` (INR, USD, …)
- `timezone`
- `locale`
- `tax_mode`: `none | simple | in_gst | vat`

Invoice lines store computed tax components as JSON/rows — **not** only CGST/SGST columns forever (keep GST fields in Indian tax profile helper).

---

## 9. Security model (Phase 1 vs later)

**Phase 1 (now in DB):** RBAC + location scope on memberships + module permissions.  
**Later:** ABAC attributes, SSO (OIDC), MFA tables, delegated admin, record-level shares.

Isolation: `tenant_id` on every row; never trust client-sent tenant.

---

## 10. Events / jobs (design hooks)

Tables ready:

- `outbox_events` — domain events for async consumers  
- `job_runs` — background job audit  
- Existing `offline_sync_events` — keep for POS offline

---

## 11. Phased delivery (so we don’t drown)

| Phase | Deliverable |
|-------|-------------|
| **P1 — this branch DB** | Universal Prisma schema + ERD + module registry + org/location + commerce core + rental extensions |
| **P2** | Nest Core adapters; rental APIs talk to new tables; seed demo rental tenant |
| **P3** | Dynamic nav from modules; FE white-label |
| **P4** | Second industry pack (e.g. simple retail grocery) to prove agnosticism |
| **P5+** | Salon/hospital packs, SSO, marketplace SDK |

---

## 12. Non-goals for P1 schema

- Full manufacturing MRP / BOM explosion  
- Full hospital EMR  
- Full payroll  
- Plugin binary SDK marketplace  
- DB sharding automation  

Schema leaves **extension points** (`custom_fields`, `tenant_modules.config`, `outbox_events`) so these plug in later without core rewrite.

---

## 13. Trade-offs

| Choice | Pro | Con |
|--------|-----|-----|
| Modular monolith | Fast, one deploy | Discipline required |
| Location instead of Store+Warehouse tables | One model | Type enum discipline |
| Order + module ext tables | Clean core | Joins for rental screens |
| Custom fields JSON + typed table | Flexible | Reporting harder — use EAV carefully |
| Keep rental demo path | No business loss | Temporary dual-thinking in migration |

---

## Next after this DB

1. Apply migration on a **new** DB or reset demo DB.  
2. Rewrite Nest modules against Core names.  
3. FE: module-aware shell (no “Tuxedo-only” IA).
