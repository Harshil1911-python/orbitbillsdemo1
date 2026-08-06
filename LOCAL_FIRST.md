# OrbitBills — local-first (IndexedDB)

## Summary
- No SQLite for app data. Everything is in browser/device IndexedDB (`techserenia_pos`).
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
- `app.py` — static host only

## Deploy
Host static files (Render etc.) or wrap with Capacitor for .apk / .aab / .exe.
