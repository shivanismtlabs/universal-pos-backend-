# Walit POS — ER Diagram (downloadable)

## Problem with mermaid.ai
Free **mermaid.ai** plan has a **code line limit** (~458). That is why you see:
- "BASIC Code line limit reached"
- "Diagram could not be exported"

Your ER is fine — the **tool plan** blocked export.

## Free export (no Plus)

### Option A — mermaid.live (recommended)
1. Open [https://mermaid.live](https://mermaid.live)  
   (different site from mermaid.ai — free export)
2. Open `walit-pos-erd.mmd` from this folder, copy all text, paste into the editor
3. Click **Actions → PNG** or **SVG** → download

### Option B — file in this repo
- Source: [`walit-pos-erd.mmd`](./walit-pos-erd.mmd)

### Option C — local CLI (optional)
```bash
npx @mermaid-js/mermaid-cli -i docs/erd/walit-pos-erd.mmd -o docs/erd/walit-pos-erd.svg
```

## Included in this ER
- SaaS: tenants, stores, plans, subscriptions, flags, RBAC, audit (+ ip/device/ua)
- Customers, measurements, parties
- Inventory: style ≠ unit, **condition + availability_status**, reservations, **inventory_movements**
- Orders, payments (**type + parent for refunds**), invoices, appointments
- Returns (+ inspect fields on return_events), cleaning, damage
- Documents, notification_logs, offline sync, webhooks, API keys
