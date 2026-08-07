# Implementation Phases — Universal Business OS

**Product:** Multi-tenant modular Business Operating System (POS = one module)  
**Branch:** `feature/universal-pos`  
**Rule:** Finish one phase before starting the next. No industry hardcoding in Core.

---

## Phase overview

```text
Phase 1  Core Database                 ✅ DONE
Phase 2  Identity & Organization       ✅ DONE
Phase 3  Core Commerce APIs            ✅ DONE
Phase 4  Module Framework              ✅ DONE
Phase 5  Retail / Pool Store Demo      ✅ DONE
Phase 6  Rental Module Demo            ✅ DONE
Phase 7  Dynamic Frontend Shell        ← NEXT
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

## Phase 2 — Identity & Organization ✅ DONE

**Goal:** First-class tenant org model + login + RBAC + location scope.

### Done
- [x] DB force-reset + universal schema applied
- [x] Seed: modules, plans, permissions, demo-shop org/locations/staff
- [x] Auth register/login → Organization + Location + Employee + Membership
- [x] APIs: organizations, locations, stores (alias), users, bootstrap
- [x] AppModule slimmed to IAM (commerce deferred to Phase 3)
- [x] Smoke: login, me, bootstrap, locations, create user

### Exit criteria
Met — demo-shop admin login works; org + 2 locations; staff with roles.

---

## Phase 3 — Core Commerce APIs ✅ DONE

**Goal:** Generic sell/stock/order/pay — no industry names in services.

### Done
- [x] Customers CRUD (+ rental measurements/parties via `mod_rental_*`)
- [x] Categories + Products (legacy `product-styles` routes)
- [x] Stock levels (retail) + stock units (serial) + reservations
- [x] Orders + order items (`kind` sale/rental) + totals
- [x] Payments + idempotency + refunds + Stripe adapted
- [x] POS checkout + receipt
- [x] Minimal returns
- [x] Outbox events on pay / status change
- [x] Seed: Pool Chemicals demo SKU + smoke sale (50→48 stock)

### Exit criteria
Met — create product stock → sale order → cash pay → receipt → qty decrement.

---

## Phase 4 — Module Framework ✅ DONE

**Goal:** Installable apps + feature flags + dependency checks.

### Done
- [x] Module catalog APIs (`GET /modules`, `GET /tenants/me/modules`)
- [x] Enable/disable with `dependsOn` closure (`rental` → core,catalog,inventory,orders,payments)
- [x] Block disable when dependents enabled
- [x] Plan `features.modules` allow-list enforcement
- [x] Feature flags get/set
- [x] Bootstrap with plan, modules, flags, nav, capabilities
- [x] Location create respects plan location limits

### Exit criteria
Met — enable rental pulls deps; inventory disable blocked while rental on; bootstrap returns nav.

---

## Phase 5 — Retail / Pool Store Demo ✅ DONE

**Goal:** Prove universal Core with a **sale** vertical (The Pool Store style).

### Done
- [x] Seed tenant `pool-store` (USD, en-US, America/New_York, taxMode simple)
- [x] Modules: core, iam, catalog, inventory, orders, pos, payments — rental **off**
- [x] Categories: Chemicals, Spa, Cleaners, Filters & Pumps, Equipment, Grills & Outdoor
- [x] 25 products + stock_levels at Valdosta Flagship
- [x] Custom field `pool_volume_gal` on customer Jordan Hayes
- [x] Smoke: `scripts/smoke-pool-store.mjs` (login → SKU → sale → pay → receipt → qty−1)
- [x] Orders use tenant `currencyCode` (not hard-coded INR)

### Exit criteria
Met — pool-supply checkout end-to-end on same Core APIs; rental disabled.

---

## Phase 6 — Rental Module Demo ✅ DONE

**Goal:** Port previous tuxedo/rental logic onto `mod_rental_*` + Core orders.

### Done
- [x] Enable `rental` (+ deps) on `demo-shop`
- [x] Seed formal-wear categories/products + serial `stock_units` + party/measurements
- [x] `POST /orders/:id/rental-lifecycle` — quote→reserved→checked_out→returned→inspected→closed
- [x] Reserve/checkout side-effects on `StockReservation` + `StockUnit` status
- [x] Returns advance lifecycle + cleaning/damage on `mod_rental_*`
- [x] Smoke: `scripts/smoke-rental.mjs`
- [x] Core remains free of industry strings (lifecycle on module ext)

### Exit criteria
Met — rental happy path on universal schema; pool-store still rental-off.

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

**Start Phase 5:** Retail / Pool Store demo tenant + richer catalog seed (FE optional).

---

## Success definition (end of Phase 7)

| Check | Pass |
|-------|------|
| Same backend + frontend codebase | ✓ |
| Tenant A: Pool retail POS | ✓ |
| Tenant B: Rental formal wear | ✓ |
| Enable/disable module changes nav | ✓ |
| No Core code `if (pool)` / `if (tuxedo)` | ✓ |
