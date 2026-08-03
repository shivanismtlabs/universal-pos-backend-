# Implementation Phases — Universal Business OS

**Product:** Multi-tenant modular Business Operating System (POS = one module)  
**Branch:** `feature/universal-pos`  
**Rule:** Finish one phase before starting the next. No industry hardcoding in Core.

---

## Phase overview

```text
Phase 1  Core Database                 ✅ DONE
Phase 2  Identity & Organization       ← NEXT
Phase 3  Core Commerce APIs
Phase 4  Module Framework
Phase 5  Retail / Pool Store Demo
Phase 6  Rental Module Demo
Phase 7  Dynamic Frontend Shell
Phase 8  Enterprise Hardening
```

---

## Phase 1 — Core Database ✅ DONE

**Goal:** Industry-agnostic schema + rental as extension tables.

### Done
- [x] Architecture doc (`universal-business-os.md`)
- [x] Prisma universal schema (`schema.prisma`)
- [x] Legacy backup + mapping (`schema.rental-legacy.prisma`, mapping doc)
- [x] ERD (`universal-business-os.mmd`)
- [x] Commit on `feature/universal-pos`

### Exit criteria
Schema validates; Core vs `mod_rental_*` clear; no live migrate until Phase 2–3 adapters ready.

---

## Phase 2 — Identity & Organization (NEXT)

**Goal:** First-class tenant org model + login + RBAC + location scope.

### Steps
1. DB migrate/push on **dev** database (reset OK for demo).
2. Seed: platform `modules`, `plans`, default `permissions`.
3. Nest APIs:
   - Auth (register tenant, login, refresh) — keep strong password/lockout logic.
   - Organizations CRUD (optional; default org on register).
   - Locations CRUD (`store` / `warehouse` / …).
   - Users + Employees + invite (email invite token — minimal).
   - Roles / permissions / memberships (location-scoped).
4. Guard: every request resolves `tenantId`; location scope on sensitive reads.
5. Smoke: owner invites cashier → cashier only sees assigned location.

### Exit criteria
- New tenant signup creates Tenant + default Org + Location + admin User/Employee.
- RBAC blocks cross-tenant and wrong-location access.
- Old “demo-shop” can be re-seeded on new schema.

### Do not do in this phase
POS cart, rental flows, Pool catalog UI.

---

## Phase 3 — Core Commerce APIs

**Goal:** Generic sell/stock/order/pay — no industry names in services.

### Steps
1. Customers CRUD (+ soft delete, custom field values API).
2. Categories + Products (`fulfillment_mode`: sale | rental | service).
3. Stock:
   - `stock_levels` (qty) for retail
   - `stock_units` (serial) for rental assets
4. Orders + OrderItems (`kind`: sale | rental | mixed | …).
5. Payments + idempotency (cash + Stripe gateway path).
6. Invoices (tax via `tax_mode` / breakdown JSON).
7. Returns (generic).
8. Register sessions (open/close float) — basic.
9. Outbox: emit `order.paid`, `stock.updated` (persist even if consumers thin).

### Exit criteria
API-only: create product → add stock → create sale order → pay → stock decrements → receipt/invoice payload.

### Do not do
Rental pickup/return UI; Pool branding FE.

---

## Phase 4 — Module Framework

**Goal:** Installable apps + feature flags + dependency checks.

### Steps
1. Seed module catalog: `core`, `iam`, `catalog`, `inventory`, `orders`, `pos`, `payments`, `rental`, `appointments`, `notify`, `reports`.
2. `GET/POST` tenant modules enable/disable.
3. Enforce `dependsOn` (e.g. rental → inventory, orders, payments, customers).
4. Feature flags inside modules (`offline_pos`, `whatsapp`, `loyalty` …).
5. Plan limits: max locations, users, allowed module codes.
6. `GET /me/bootstrap` → user + tenant + enabled modules + flags + nav schema.

### Exit criteria
Enabling `rental` auto-requires deps; plan can block a module; bootstrap drives FE later.

---

## Phase 5 — Retail / Pool Store Demo

**Goal:** Prove universal Core with a **sale** vertical (The Pool Store style).

### Steps
1. Seed tenant e.g. `pool-store` (USD or INR — config).
2. Enable modules: catalog, inventory, orders, pos, payments (rental **off**).
3. Seed categories: Chemicals, Spa, Cleaners, Equipment, Grills/Outdoor…
4. Seed 20–40 products + qty stock_levels.
5. Minimal FE or Postman collection: search SKU → cart → pay → receipt.
6. Optional custom fields: e.g. “Pool volume (gal)” on customer — via metadata, not new columns.

### Exit criteria
Stakeholder can run a pool-supply checkout end-to-end on same platform code.

---

## Phase 6 — Rental Module Demo

**Goal:** Port previous tuxedo/rental logic onto `mod_rental_*` + Core orders.

### Steps
1. Enable `rental` (+ deps) on `demo-shop` / formal tenant.
2. APIs for rental extension: pickup/return dates, parties, measurements, cleaning, damage.
3. Map old Nest rental services → new tables (reuse business rules).
4. Status lifecycle in module config (`quote → … → returned`), not Core enums only.
5. Seed formal-wear serial `stock_units` + rental prices.

### Exit criteria
Old rental happy path works on new schema; Core still has no “tuxedo” strings.

---

## Phase 7 — Dynamic Frontend Shell

**Goal:** One Next.js app; face changes by tenant modules + branding.

### Steps
1. Remove hard-coded “Tuxedo” as only brand — read tenant branding.
2. Sidebar/routes from bootstrap `nav_schema` + permissions.
3. POS screen: generic cart; show rental line actions only if module on.
4. Inventory: qty UI vs serial UI from product flags.
5. Pool tenant vs Rental tenant = same build, different config.
6. Login + session expiry (keep existing quality).

### Exit criteria
Switch tenant (or module set) → nav and POS behaviour change without redeploying a second app.

---

## Phase 8 — Enterprise Hardening

**Goal:** Scale toward “any business” without redesigning Core.

### Steps (prioritize as needed)
1. Workflow engine (approval chains) — optional.
2. Stronger audit coverage on all writes.
3. SSO / MFA / passwordless.
4. Multi-tax / multi-currency polish.
5. Offline POS sync hardening.
6. Webhooks + API keys UI.
7. Plugin SDK / marketplace (last).
8. More packs: salon, grocery, repair… one at a time.

### Exit criteria
Chosen enterprise items shipped without Core table rewrites.

---

## Working rules (every phase)

1. **Core never knows industry** — pool/salon/rental only in modules/seed/config.
2. **Custom fields** for one-off attributes — not new Core columns.
3. **Modules + feature_flags** — apps vs switches inside apps.
4. **One vertical prove at a time** — Pool then Rental, then others.
5. **Do not migrate production** until Phase 3 exit criteria pass on staging.
6. Keep commits on `feature/universal-pos` (or phase sub-branches).

---

## Immediate next action

**Start Phase 2:**  
Dev DB reset → Prisma migrate → seed modules/plans/permissions → Auth + Org + Location + Employee/RBAC APIs → smoke invite flow.

---

## Success definition (end of Phase 7)

| Check | Pass |
|-------|------|
| Same backend + frontend codebase | ✓ |
| Tenant A: Pool retail POS | ✓ |
| Tenant B: Rental formal wear | ✓ |
| Enable/disable module changes nav | ✓ |
| No Core code `if (pool)` / `if (tuxedo)` | ✓ |
