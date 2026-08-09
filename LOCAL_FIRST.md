# OrbitBills — local-first (IndexedDB)

## Why data survives Render restarts
All products, clients, invoices, stock, payments, quotations, cash shifts, settings, and auth sessions live in the **browser’s IndexedDB** (`techserenia_pos`), not on the server.

When Render (or any host) restarts, rebuilds, or redeploys, only static files are refreshed. **IndexedDB is never touched by the server**, so your data stays on the device — same behaviour as OrbitBills v1.

## Summary
- No SQLite for app data in normal use. Everything is in browser/device IndexedDB.
- Flask `app.py` is a static host only; `/api/*` returns 410 (gone) — use `tsLocalApi()` in `Db.js`.
- No public sign-up. Three preset accounts only.
- Admin, Billing, Accountant on the same device share one DB and sync via BroadcastChannel.
- Client A data never reaches Client B (IndexedDB is per device/profile).

## Preset logins
| Email | Password | Panel |
|-------|----------|-------|
| admin@techserenia.com | TechSerenia@2026 | Admin |
| billing@techserenia.com | TechSerenia@2026 | Billing |
| accountant@techserenia.com | TechSerenia@2026 | Accountant |

## Key files
- `Db.js` — IndexedDB + `tsLocalApi()` (replaces server `/api/admin/*`)
- `signin.html` — sign-in only
- `admin-dashboard.html`, `billing.html`, `accountant-dashboard.html`
- `app.py` — static host + 404 → `404error.html`
- `404error.html` — friendly not-found page

## Deploy
Host static files (Render static site, Netlify, nginx) **or** run Flask:

```bash
pip install -r requirements.txt
python app.py
```

Or wrap with Capacitor for .apk / .aab / .exe.

## Backup
Admin → Backup & restore → Download backup ZIP (IndexedDB export).
Restore accepts .zip or .json. Fully offline; no server session required.

## Quotations
Admin → Quotations, or Billing → Quote (saves current cart as quotation).
Convert quote → invoice from admin. Quotes keep variant_id and weight qty.

## Variants & weight at the counter
- Products with variants open a picker before adding to cart.
- Units kg, g, litre, ml open a weight/amount popup (price × amount).
- Variant barcodes can be scanned directly.
- Stock adjusts on parent product and on the chosen variant.

## Inventory
Admin → Inventory: manual adjust, movement log, expiring batches.
All stock changes write `inventory_movements` in IndexedDB and sync via BroadcastChannel.

## Due invoices
Admin → Due invoices. Optional browser notifications on this device.
Billing shows a banner for due/overdue invoices.

## Accountant (GST)
Open `accountant-dashboard.html` with the accountant preset account.
GST summary, tax by rate, HSN, B2B/B2C and a simplified GSTR-1 JSON export — all from IndexedDB invoices on this device.
