# OrbitBills (TechSerenia) — local-first

**Data storage:** browser IndexedDB (`techserenia_pos`).  
Server restarts / Render redeploys **do not** delete invoices, products, or stock.

## Quick start
```bash
pip install -r requirements.txt
python app.py
# open http://127.0.0.1:5000
```

Or upload this folder as a **static site** (no Python required). All routes are `.html` + `Db.js`.

## Sign in
| Role | Email | Password |
|------|-------|----------|
| Admin | admin@techserenia.com | TechSerenia@2026 |
| Billing | billing@techserenia.com | TechSerenia@2026 |
| Accountant | accountant@techserenia.com | TechSerenia@2026 |

See `LOCAL_FIRST.md` for architecture details.
