"""
admin.py
--------
Everything the Admin dashboard needs, in one file.

Enhanced with:
  - Stock deduction / restoration on invoice create / update / delete
  - Backup & restore (JSON + images as base64)
  - Email sending (SMTP credentials supplied per-request from IndexedDB)
  - CSV export endpoints
  - Layout update / delete from UI
  - User role change
  - Invoice layout_id persistence
  - Overview revenue stats
  - Apply client credit on invoices
  - Quick mark-paid
  - Delete orphaned product photos
"""

import os
import time
import uuid
import json
import base64
import io
import zipfile
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from functools import wraps
from contextlib import contextmanager
from datetime import datetime

from flask import Blueprint, request, jsonify, session, send_from_directory, Response
from werkzeug.utils import secure_filename

import database
import session_manager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_ROOT = os.path.join(BASE_DIR, "uploads")
PRODUCT_UPLOAD_DIR = os.path.join(UPLOAD_ROOT, "products")
BRANDING_UPLOAD_DIR = os.path.join(UPLOAD_ROOT, "branding")

ALLOWED_IMAGE_EXT = {"png", "jpg", "jpeg", "webp", "gif", "svg"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5MB

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
DB_PATH = database.DB_PATH


# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------

def ensure_upload_dirs():
    os.makedirs(PRODUCT_UPLOAD_DIR, exist_ok=True)
    os.makedirs(BRANDING_UPLOAD_DIR, exist_ok=True)


@contextmanager
def get_connection():
    with database.get_connection() as conn:
        yield conn


def init_admin_db():
    ensure_upload_dirs()
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tax_slabs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                percentage REAL NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                brand TEXT DEFAULT '',
                store_type TEXT DEFAULT 'other',
                category TEXT DEFAULT '',
                unit TEXT DEFAULT 'pcs',
                price REAL NOT NULL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                low_stock_limit INTEGER,
                tax_slab_id INTEGER,
                sku TEXT DEFAULT '',
                hsn_code TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                photo_path TEXT,
                color TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (tax_slab_id) REFERENCES tax_slabs(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                address TEXT DEFAULT '',
                gstin TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                credit_balance REAL NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS credit_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                reason TEXT DEFAULT '',
                balance_after REAL NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (client_id) REFERENCES clients(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_number TEXT NOT NULL,
                client_id INTEGER,
                client_name TEXT DEFAULT '',
                subtotal REAL NOT NULL DEFAULT 0,
                discount REAL NOT NULL DEFAULT 0,
                tax_amount REAL NOT NULL DEFAULT 0,
                total REAL NOT NULL DEFAULT 0,
                credit_applied REAL NOT NULL DEFAULT 0,
                status TEXT DEFAULT 'unpaid',
                notes TEXT DEFAULT '',
                layout_id INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (client_id) REFERENCES clients(id)
            )
            """
        )
        # migration: add credit_applied if missing (older DBs)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(invoices)").fetchall()]
        if "credit_applied" not in cols:
            conn.execute("ALTER TABLE invoices ADD COLUMN credit_applied REAL NOT NULL DEFAULT 0")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoice_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                qty REAL NOT NULL DEFAULT 1,
                price REAL NOT NULL DEFAULT 0,
                tax_percent REAL NOT NULL DEFAULT 0,
                FOREIGN KEY (invoice_id) REFERENCES invoices(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS branding_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoice_layouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                is_preset INTEGER NOT NULL DEFAULT 0,
                elements_json TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                address TEXT DEFAULT '',
                gstin TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchase_number TEXT NOT NULL,
                supplier_id INTEGER,
                supplier_name TEXT DEFAULT '',
                subtotal REAL NOT NULL DEFAULT 0,
                tax_amount REAL NOT NULL DEFAULT 0,
                total REAL NOT NULL DEFAULT 0,
                status TEXT DEFAULT 'received',
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS purchase_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchase_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                qty REAL NOT NULL DEFAULT 1,
                cost REAL NOT NULL DEFAULT 0,
                tax_percent REAL NOT NULL DEFAULT 0,
                FOREIGN KEY (purchase_id) REFERENCES purchases(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS inventory_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER,
                product_name TEXT DEFAULT '',
                delta INTEGER NOT NULL,
                reason TEXT DEFAULT '',
                ref_type TEXT DEFAULT '',
                ref_id INTEGER,
                balance_after INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoice_share_tokens (
                token TEXT PRIMARY KEY,
                invoice_id INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                method TEXT DEFAULT 'cash',
                reference TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS quotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quote_number TEXT NOT NULL,
                client_id INTEGER,
                client_name TEXT DEFAULT '',
                subtotal REAL NOT NULL DEFAULT 0,
                discount REAL NOT NULL DEFAULT 0,
                tax_amount REAL NOT NULL DEFAULT 0,
                total REAL NOT NULL DEFAULT 0,
                status TEXT DEFAULT 'draft',
                notes TEXT DEFAULT '',
                valid_until TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS quotation_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quotation_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                qty REAL NOT NULL DEFAULT 1,
                price REAL NOT NULL DEFAULT 0,
                tax_percent REAL NOT NULL DEFAULT 0,
                FOREIGN KEY (quotation_id) REFERENCES quotations(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_variants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                sku TEXT DEFAULT '',
                barcode TEXT DEFAULT '',
                price REAL,
                cost_price REAL,
                stock INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                variant_id INTEGER,
                batch_number TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 0,
                expiry_date TEXT DEFAULT '',
                manufactured_date TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                code_type TEXT NOT NULL DEFAULT 'qr',
                payload TEXT NOT NULL,
                design_json TEXT DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # invoice due_date, amount_paid migration
        icols = [r[1] for r in conn.execute("PRAGMA table_info(invoices)").fetchall()]
        if "due_date" not in icols:
            conn.execute("ALTER TABLE invoices ADD COLUMN due_date TEXT DEFAULT ''")
        if "amount_paid" not in icols:
            conn.execute("ALTER TABLE invoices ADD COLUMN amount_paid REAL NOT NULL DEFAULT 0")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cash_shifts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email TEXT DEFAULT '',
                user_name TEXT DEFAULT '',
                opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
                closed_at TEXT,
                opening_float REAL NOT NULL DEFAULT 0,
                closing_cash REAL,
                expected_cash REAL,
                cash_sales REAL DEFAULT 0,
                card_sales REAL DEFAULT 0,
                upi_sales REAL DEFAULT 0,
                other_sales REAL DEFAULT 0,
                variance REAL,
                notes TEXT DEFAULT '',
                status TEXT DEFAULT 'open'
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS held_bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT DEFAULT '',
                client_id INTEGER,
                client_name TEXT DEFAULT '',
                cart_json TEXT NOT NULL,
                discount REAL DEFAULT 0,
                credit_applied REAL DEFAULT 0,
                notes TEXT DEFAULT '',
                created_by TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_lists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_list_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                price_list_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                price REAL NOT NULL,
                UNIQUE(price_list_id, product_id),
                FOREIGN KEY (price_list_id) REFERENCES price_lists(id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS returns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                return_number TEXT NOT NULL,
                invoice_id INTEGER,
                client_id INTEGER,
                client_name TEXT DEFAULT '',
                total REAL NOT NULL DEFAULT 0,
                restock INTEGER DEFAULT 1,
                credit_to_client INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS return_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                return_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                qty REAL NOT NULL DEFAULT 1,
                price REAL NOT NULL DEFAULT 0,
                FOREIGN KEY (return_id) REFERENCES returns(id)
            )
            """
        )
        # client price_list_id
        ccols = [r[1] for r in conn.execute("PRAGMA table_info(clients)").fetchall()]
        if "price_list_id" not in ccols:
            conn.execute("ALTER TABLE clients ADD COLUMN price_list_id INTEGER")
        for k, v in [
            ("upi_id", ""), ("upi_name", ""), ("payment_link_note", "Pay via UPI using the QR or link"),
        ]:
            existing = conn.execute("SELECT 1 FROM branding_settings WHERE key = ?", (k,)).fetchone()
            if not existing:
                conn.execute("INSERT INTO branding_settings (key, value) VALUES (?, ?)", (k, v))

        pcols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
        if "cost_price" not in pcols:
            conn.execute("ALTER TABLE products ADD COLUMN cost_price REAL NOT NULL DEFAULT 0")
        if "barcode" not in pcols:
            conn.execute("ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT ''")
        for k, v in [("whatsapp_enabled", "no"), ("low_stock_alert_email", ""), ("low_stock_alert_enabled", "no")]:
            existing = conn.execute("SELECT 1 FROM branding_settings WHERE key = ?", (k,)).fetchone()
            if not existing:
                conn.execute("INSERT INTO branding_settings (key, value) VALUES (?, ?)", (k, v))

        row = conn.execute("SELECT COUNT(*) c FROM tax_slabs").fetchone()
        if row["c"] == 0:
            for name, pct, is_default in [
                ("GST 0%", 0, 0), ("GST 5%", 5, 0), ("GST 12%", 12, 1),
                ("GST 18%", 18, 0), ("GST 28%", 28, 0),
            ]:
                conn.execute(
                    "INSERT INTO tax_slabs (name, percentage, is_default) VALUES (?, ?, ?)",
                    (name, pct, is_default),
                )

        defaults = {
            "brand_name": "TechSerenia",
            "brand_tagline": "OrbitBills",
            "brand_address": "",
            "brand_email": "",
            "brand_phone": "",
            "accent_color": "#0b3d91",
            "footer_note": "Thank you for your business!",
            "show_techserenia_logo": "yes",
            "show_orbitbills_branding": "yes",
            "active_layout_id": "",
            "default_low_stock_limit": "5",
            "currency_symbol": "₹",
        }
        for k, v in defaults.items():
            existing = conn.execute("SELECT 1 FROM branding_settings WHERE key = ?", (k,)).fetchone()
            if not existing:
                conn.execute("INSERT INTO branding_settings (key, value) VALUES (?, ?)", (k, v))

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS coupons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT DEFAULT '',
                discount_type TEXT NOT NULL DEFAULT 'pct',
                value REAL NOT NULL DEFAULT 0,
                min_order REAL NOT NULL DEFAULT 0,
                max_discount REAL,
                max_uses INTEGER,
                used_count INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1,
                expires_at TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER,
                product_name TEXT DEFAULT '',
                old_price REAL,
                new_price REAL,
                user_email TEXT DEFAULT '',
                reason TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        for k, v in [
            ("price_override_pin", "1234"),
            ("max_discount_pct", "50"),
            ("allow_price_override", "yes"),
        ]:
            existing = conn.execute("SELECT 1 FROM branding_settings WHERE key = ?", (k,)).fetchone()
            if not existing:
                conn.execute("INSERT INTO branding_settings (key, value) VALUES (?, ?)", (k, v))


        row = conn.execute("SELECT COUNT(*) c FROM invoice_layouts").fetchone()
        if row["c"] == 0:
            presets = _preset_layouts()
            for name, elements in presets:
                conn.execute(
                    "INSERT INTO invoice_layouts (name, is_preset, elements_json) VALUES (?, 1, ?)",
                    (name, json.dumps(elements)),
                )
            first = conn.execute("SELECT id FROM invoice_layouts ORDER BY id LIMIT 1").fetchone()
            if first:
                conn.execute(
                    "UPDATE branding_settings SET value = ? WHERE key = 'active_layout_id'",
                    (str(first["id"]),),
                )


def _preset_layouts():
    classic = [
        {"id": "logo", "type": "logo", "x": 30, "y": 30, "w": 90, "h": 90},
        {"id": "brand", "type": "brand_name", "x": 130, "y": 40, "w": 300, "h": 30},
        {"id": "address", "type": "brand_address", "x": 130, "y": 74, "w": 300, "h": 50},
        {"id": "invmeta", "type": "invoice_meta", "x": 440, "y": 40, "w": 130, "h": 80},
        {"id": "billto", "type": "bill_to", "x": 30, "y": 150, "w": 260, "h": 80},
        {"id": "table", "type": "items_table", "x": 30, "y": 250, "w": 540, "h": 340},
        {"id": "totals", "type": "totals", "x": 340, "y": 600, "w": 230, "h": 110},
        {"id": "footer", "type": "footer_note", "x": 30, "y": 730, "w": 540, "h": 40},
        {"id": "orbit", "type": "orbitbills_badge", "x": 30, "y": 770, "w": 200, "h": 20},
    ]
    modern_centered = [
        {"id": "logo", "type": "logo", "x": 255, "y": 30, "w": 90, "h": 90},
        {"id": "brand", "type": "brand_name", "x": 150, "y": 128, "w": 300, "h": 30},
        {"id": "address", "type": "brand_address", "x": 150, "y": 160, "w": 300, "h": 40},
        {"id": "invmeta", "type": "invoice_meta", "x": 30, "y": 220, "w": 200, "h": 70},
        {"id": "billto", "type": "bill_to", "x": 370, "y": 220, "w": 200, "h": 70},
        {"id": "table", "type": "items_table", "x": 30, "y": 310, "w": 540, "h": 320},
        {"id": "totals", "type": "totals", "x": 340, "y": 645, "w": 230, "h": 110},
        {"id": "footer", "type": "footer_note", "x": 30, "y": 765, "w": 540, "h": 30},
        {"id": "orbit", "type": "orbitbills_badge", "x": 200, "y": 775, "w": 200, "h": 20},
    ]
    compact_left = [
        {"id": "logo", "type": "logo", "x": 30, "y": 30, "w": 70, "h": 70},
        {"id": "brand", "type": "brand_name", "x": 110, "y": 35, "w": 260, "h": 26},
        {"id": "address", "type": "brand_address", "x": 110, "y": 62, "w": 260, "h": 40},
        {"id": "invmeta", "type": "invoice_meta", "x": 400, "y": 30, "w": 170, "h": 70},
        {"id": "billto", "type": "bill_to", "x": 30, "y": 120, "w": 260, "h": 70},
        {"id": "table", "type": "items_table", "x": 30, "y": 210, "w": 540, "h": 380},
        {"id": "totals", "type": "totals", "x": 340, "y": 610, "w": 230, "h": 100},
        {"id": "footer", "type": "footer_note", "x": 30, "y": 725, "w": 540, "h": 30},
        {"id": "orbit", "type": "orbitbills_badge", "x": 30, "y": 760, "w": 200, "h": 20},
    ]
    return [
        ("Classic", classic),
        ("Modern centered", modern_centered),
        ("Compact", compact_left),
    ]


# ---------------------------------------------------------------------------
# auth guard
# ---------------------------------------------------------------------------

def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if session.get("role") != "admin":
            return jsonify({"ok": False, "error": "Admin sign-in required."}), 401
        return fn(*args, **kwargs)
    return wrapper


def require_billing_or_admin(fn):
    """Products, clients, invoices, and branding for the billing counter."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if session.get("role") not in ("admin", "billing"):
            return jsonify({"ok": False, "error": "Admin or billing sign-in required."}), 401
        return fn(*args, **kwargs)
    return wrapper


def require_accountant_or_admin(fn):
    """Read-only financial views (invoices, tax slabs) for the accountant role."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if session.get("role") not in ("admin", "accountant"):
            return jsonify({"ok": False, "error": "Admin or accountant sign-in required."}), 401
        return fn(*args, **kwargs)
    return wrapper


def require_billing_accountant_or_admin(fn):
    """Read access to invoices/tax slabs for billing, accountant, and admin."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if session.get("role") not in ("admin", "billing", "accountant"):
            return jsonify({"ok": False, "error": "Sign-in required."}), 401
        return fn(*args, **kwargs)
    return wrapper


@bp.errorhandler(413)
def too_large(e):
    return jsonify({"ok": False, "error": "File is too large (max 5MB)."}), 413


# ---------------------------------------------------------------------------
# sessions (admin panel "Sessions" page -- see session_manager.py)
# ---------------------------------------------------------------------------

def _relative_time(ts: str) -> str:
    try:
        from datetime import datetime
        delta = datetime.utcnow() - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return ts
    secs = int(delta.total_seconds())
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


@bp.route("/sessions", methods=["GET"])
@require_admin
def list_sessions():
    session_manager.cleanup_expired()
    current_id = session_manager.get_id_by_token(session.get("session_token"))
    rows = session_manager.list_active_sessions()
    for r in rows:
        r["is_current"] = (r["id"] == current_id)
        r["last_active_relative"] = _relative_time(r["last_active_at"])
    return jsonify({"ok": True, "sessions": rows, "currentSessionId": current_id})


@bp.route("/sessions/<int:session_id>/revoke", methods=["POST"])
@require_admin
def revoke_session_route(session_id):
    current_id = session_manager.get_id_by_token(session.get("session_token"))
    session_manager.revoke_by_id(session_id)
    return jsonify({"ok": True, "revokedCurrent": session_id == current_id})


@bp.route("/sessions/revoke-others", methods=["POST"])
@require_admin
def revoke_other_sessions_route():
    """Sign every device EXCEPT the one making this request out."""
    token = session.get("session_token")
    email = session.get("email")
    session_manager.revoke_all_for_email(email, except_token=token)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# database management (admin panel "Database" page)
# ---------------------------------------------------------------------------

# Every business table, grouped into the same categories the Database page
# shows as checkboxes. tax_slabs, branding_settings, and invoice_layouts are
# deliberately excluded from every category -- those are store configuration,
# not business data, and wiping them out from under the UI would break it.
# Listed child-table-first so foreign keys never dangle mid-wipe.
DB_WIPE_CATEGORIES = {
    "products": ["product_batches", "product_variants", "inventory_movements", "products"],
    "clients": ["credit_transactions", "clients"],
    "invoices": [
        "return_items", "returns", "payments", "invoice_share_tokens",
        "quotation_items", "quotations", "invoice_items", "invoices",
    ],
    "purchasing": ["purchase_items", "purchases", "suppliers"],
    "operations": ["held_bills", "price_list_items", "price_lists", "saved_codes", "cash_shifts"],
}

DB_COUNT_TABLES = {
    "Products": "products",
    "Clients": "clients",
    "Invoices": "invoices",
    "Quotations": "quotations",
    "Suppliers": "suppliers",
    "Purchases": "purchases",
    "Price lists": "price_lists",
    "Saved codes": "saved_codes",
}


@bp.route("/database/counts", methods=["GET"])
@require_admin
def database_counts():
    with get_connection() as conn:
        counts = {
            label: conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
            for label, table in DB_COUNT_TABLES.items()
        }
    return jsonify({"ok": True, "counts": counts})


@bp.route("/database/wipe", methods=["POST"])
@require_admin
def database_wipe():
    data = request.get_json(silent=True) or {}
    categories = data.get("categories") or []
    confirm = (data.get("confirm") or "").strip()

    if confirm != "DELETE":
        return jsonify({"ok": False, "error": "Type DELETE to confirm."}), 400
    if not categories:
        return jsonify({"ok": False, "error": "Select at least one category to delete."}), 400
    unknown = [c for c in categories if c not in DB_WIPE_CATEGORIES]
    if unknown:
        return jsonify({"ok": False, "error": f"Unknown category: {unknown[0]}"}), 400

    deleted = {}
    with get_connection() as conn:
        for cat in categories:
            for table in DB_WIPE_CATEGORIES[cat]:
                cur = conn.execute(f"DELETE FROM {table}")
                deleted[table] = cur.rowcount

    if "products" in categories:
        # Product photos on disk have no other owner once the rows are gone.
        try:
            for fn in os.listdir(PRODUCT_UPLOAD_DIR):
                fp = os.path.join(PRODUCT_UPLOAD_DIR, fn)
                if os.path.isfile(fp):
                    os.remove(fp)
        except FileNotFoundError:
            pass

    return jsonify({"ok": True, "deleted": deleted})


# ---------------------------------------------------------------------------
# uploads
# ---------------------------------------------------------------------------

def _allowed_image(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_IMAGE_EXT


def _save_image(file_storage, folder):
    if not file_storage or not file_storage.filename:
        return None
    if not _allowed_image(file_storage.filename):
        raise ValueError("Only png, jpg, jpeg, webp, gif, or svg images are allowed.")
    ext = file_storage.filename.rsplit(".", 1)[1].lower()
    safe_name = f"{uuid.uuid4().hex}.{ext}"
    dest_dir = PRODUCT_UPLOAD_DIR if folder == "products" else BRANDING_UPLOAD_DIR
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, safe_name)
    file_storage.save(path)
    return f"/uploads/{folder}/{safe_name}"


def _delete_image_file(photo_path):
    """Remove a previously uploaded image from disk if it lives under uploads/."""
    if not photo_path or not photo_path.startswith("/uploads/"):
        return
    parts = photo_path.strip("/").split("/")
    if len(parts) < 3:
        return
    folder, filename = parts[1], parts[2]
    if folder not in ("products", "branding"):
        return
    directory = PRODUCT_UPLOAD_DIR if folder == "products" else BRANDING_UPLOAD_DIR
    full = os.path.join(directory, secure_filename(filename))
    if os.path.isfile(full):
        try:
            os.remove(full)
        except OSError:
            pass


uploads_bp = Blueprint("admin_uploads", __name__)


@uploads_bp.route("/uploads/<folder>/<path:filename>")
def serve_upload(folder, filename):
    if folder not in ("products", "branding"):
        return jsonify({"error": "Not found"}), 404
    directory = PRODUCT_UPLOAD_DIR if folder == "products" else BRANDING_UPLOAD_DIR
    safe = secure_filename(filename)
    if not os.path.exists(os.path.join(directory, safe)):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(directory, safe)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def row_to_dict(row):
    return dict(row) if row else None


def _json_body():
    return request.get_json(silent=True) or {}


def _is_multipart():
    return request.content_type and "multipart/form-data" in request.content_type


def _field(name, default=""):
    if _is_multipart():
        return request.form.get(name, default)
    return _json_body().get(name, default)


def _adjust_stock(conn, product_id, delta, reason="", ref_type="", ref_id=None):
    """Change stock by delta (negative to deduct). Clamps at 0. Logs movement."""
    if not product_id:
        return
    row = conn.execute("SELECT id, name, stock FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return
    new_stock = max(0, int(row["stock"] or 0) + int(delta))
    conn.execute(
        "UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_stock, product_id),
    )
    try:
        conn.execute(
            """INSERT INTO inventory_movements
               (product_id, product_name, delta, reason, ref_type, ref_id, balance_after)
               VALUES (?,?,?,?,?,?,?)""",
            (product_id, row["name"], int(delta), reason, ref_type, ref_id, new_stock),
        )
    except Exception:
        pass


def _restore_invoice_stock(conn, invoice_id):
    """Add quantities back to product stock for an invoice about to be deleted/replaced."""
    items = conn.execute(
        "SELECT product_id, qty FROM invoice_items WHERE invoice_id = ?", (invoice_id,)
    ).fetchall()
    for it in items:
        if it["product_id"]:
            _adjust_stock(conn, it["product_id"], int(float(it["qty"] or 0)),
                          reason="Invoice stock restore", ref_type="invoice", ref_id=invoice_id)


def _deduct_invoice_stock(conn, items, invoice_id=None):
    for it in items:
        pid = it.get("productId") or it.get("product_id")
        qty = float(it.get("qty", 1) or 1)
        if pid:
            _adjust_stock(conn, pid, -int(qty), reason="Invoice sale",
                          ref_type="invoice", ref_id=invoice_id)


# ---------------------------------------------------------------------------
# OVERVIEW
# ---------------------------------------------------------------------------

@bp.route("/overview")
@require_admin
def overview():
    with get_connection() as conn:
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        products = conn.execute("SELECT COUNT(*) c FROM products").fetchone()["c"]
        clients = conn.execute("SELECT COUNT(*) c FROM clients").fetchone()["c"]
        invoices = conn.execute("SELECT COUNT(*) c FROM invoices").fetchone()["c"]
        low_rows = conn.execute(
            """
            SELECT * FROM products
            WHERE stock <= COALESCE(low_stock_limit, ?)
            ORDER BY stock ASC
            """,
            (default_limit,),
        ).fetchall()
        total_credits = conn.execute(
            "SELECT COALESCE(SUM(credit_balance),0) s FROM clients"
        ).fetchone()["s"]
        revenue_paid = conn.execute(
            "SELECT COALESCE(SUM(total),0) s FROM invoices WHERE status = 'paid'"
        ).fetchone()["s"]
        revenue_unpaid = conn.execute(
            "SELECT COALESCE(SUM(total),0) s FROM invoices WHERE status = 'unpaid'"
        ).fetchone()["s"]
        recent = conn.execute(
            "SELECT id, invoice_number, client_name, total, status, created_at FROM invoices ORDER BY created_at DESC LIMIT 8"
        ).fetchall()
    return jsonify({
        "ok": True,
        "stats": {
            "products": products, "clients": clients, "invoices": invoices,
            "lowStock": len(low_rows), "totalClientCredits": total_credits,
            "revenuePaid": revenue_paid, "revenueUnpaid": revenue_unpaid,
        },
        "lowStockProducts": [row_to_dict(r) for r in low_rows],
        "recentInvoices": [row_to_dict(r) for r in recent],
    })


# ---------------------------------------------------------------------------
# TAX SLABS
# ---------------------------------------------------------------------------

@bp.route("/tax-slabs", methods=["GET"])
@require_billing_accountant_or_admin
def list_tax_slabs():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM tax_slabs ORDER BY percentage ASC").fetchall()
    return jsonify({"ok": True, "taxSlabs": [row_to_dict(r) for r in rows]})


@bp.route("/tax-slabs", methods=["POST"])
@require_admin
def create_tax_slab():
    data = _json_body()
    name = (data.get("name") or "").strip()
    percentage = data.get("percentage")
    if not name or percentage is None:
        return jsonify({"ok": False, "error": "Name and percentage are required."}), 400
    try:
        percentage = float(percentage)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Percentage must be a number."}), 400
    is_default = 1 if data.get("isDefault") else 0
    with get_connection() as conn:
        if is_default:
            conn.execute("UPDATE tax_slabs SET is_default = 0")
        cur = conn.execute(
            "INSERT INTO tax_slabs (name, percentage, is_default) VALUES (?, ?, ?)",
            (name, percentage, is_default),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/tax-slabs/<int:slab_id>", methods=["PUT"])
@require_admin
def update_tax_slab(slab_id):
    data = _json_body()
    name = (data.get("name") or "").strip()
    percentage = data.get("percentage")
    if not name or percentage is None:
        return jsonify({"ok": False, "error": "Name and percentage are required."}), 400
    is_default = 1 if data.get("isDefault") else 0
    with get_connection() as conn:
        if is_default:
            conn.execute("UPDATE tax_slabs SET is_default = 0")
        conn.execute(
            "UPDATE tax_slabs SET name = ?, percentage = ?, is_default = ? WHERE id = ?",
            (name, float(percentage), is_default, slab_id),
        )
    return jsonify({"ok": True})


@bp.route("/tax-slabs/<int:slab_id>", methods=["DELETE"])
@require_admin
def delete_tax_slab(slab_id):
    with get_connection() as conn:
        in_use = conn.execute(
            "SELECT COUNT(*) c FROM products WHERE tax_slab_id = ?", (slab_id,)
        ).fetchone()["c"]
        if in_use:
            return jsonify({"ok": False, "error": f"{in_use} product(s) use this tax slab. Reassign them first."}), 400
        conn.execute("DELETE FROM tax_slabs WHERE id = ?", (slab_id,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# PRODUCTS
# ---------------------------------------------------------------------------

@bp.route("/products", methods=["GET"])
@require_billing_or_admin
def list_products():
    q = request.args.get("q", "").strip().lower()
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT p.*, t.name as tax_name, t.percentage as tax_percentage
            FROM products p LEFT JOIN tax_slabs t ON p.tax_slab_id = t.id
            ORDER BY p.created_at DESC
            """
        ).fetchall()
    products = [row_to_dict(r) for r in rows]
    if q:
        products = [
            p for p in products
            if q in (p["name"] or "").lower()
            or q in (p["brand"] or "").lower()
            or q in (p["sku"] or "").lower()
            or q in (p["category"] or "").lower()
        ]
    return jsonify({"ok": True, "products": products})


@bp.route("/products", methods=["POST"])
@require_admin
def create_product():
    try:
        name = _field("name").strip()
        if not name:
            return jsonify({"ok": False, "error": "Product name is required."}), 400
        photo_path = None
        if _is_multipart() and "photo" in request.files:
            photo_path = _save_image(request.files["photo"], "products")

        record = {
            "name": name,
            "brand": _field("brand", ""),
            "store_type": _field("storeType", "other"),
            "category": _field("category", ""),
            "unit": _field("unit", "pcs"),
            "price": float(_field("price", 0) or 0),
            "stock": int(_field("stock", 0) or 0),
            "low_stock_limit": (int(_field("lowStockLimit")) if _field("lowStockLimit") else None),
            "tax_slab_id": (int(_field("taxSlabId")) if _field("taxSlabId") else None),
            "sku": _field("sku", ""),
            "hsn_code": _field("hsnCode", ""),
            "notes": _field("notes", ""),
            "cost_price": float(_field("costPrice", 0) or 0),
            "barcode": _field("barcode", ""),
        }
        with get_connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO products
                    (name, brand, store_type, category, unit, price, stock,
                     low_stock_limit, tax_slab_id, sku, hsn_code, notes, photo_path, cost_price, barcode)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (record["name"], record["brand"], record["store_type"], record["category"],
                 record["unit"], record["price"], record["stock"], record["low_stock_limit"],
                 record["tax_slab_id"], record["sku"], record["hsn_code"], record["notes"], photo_path,
                 record["cost_price"], record["barcode"]),
            )
        return jsonify({"ok": True, "id": cur.lastrowid})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@bp.route("/products/<int:product_id>", methods=["PUT"])
@require_admin
def update_product(product_id):
    try:
        with get_connection() as conn:
            existing = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
            if not existing:
                return jsonify({"ok": False, "error": "Product not found."}), 404

            photo_path = existing["photo_path"]
            if _is_multipart() and "photo" in request.files and request.files["photo"].filename:
                _delete_image_file(photo_path)
                photo_path = _save_image(request.files["photo"], "products")
            if _field("removePhoto", "") == "1":
                _delete_image_file(photo_path)
                photo_path = None

            name = _field("name", existing["name"]).strip() or existing["name"]
            conn.execute(
                """
                UPDATE products SET name=?, brand=?, store_type=?, category=?, unit=?, price=?,
                    stock=?, low_stock_limit=?, tax_slab_id=?, sku=?, hsn_code=?, notes=?,
                    photo_path=?, cost_price=?, barcode=?, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                (
                    name,
                    _field("brand", existing["brand"]),
                    _field("storeType", existing["store_type"]),
                    _field("category", existing["category"]),
                    _field("unit", existing["unit"]),
                    float(_field("price", existing["price"]) or 0),
                    int(_field("stock", existing["stock"]) or 0),
                    (int(_field("lowStockLimit")) if _field("lowStockLimit") else None),
                    (int(_field("taxSlabId")) if _field("taxSlabId") else None),
                    _field("sku", existing["sku"]),
                    _field("hsnCode", existing["hsn_code"]),
                    _field("notes", existing["notes"]),
                    photo_path,
                    float(_field("costPrice", existing["cost_price"] if "cost_price" in existing.keys() else 0) or 0),
                    _field("barcode", existing["barcode"] if "barcode" in existing.keys() else ""),
                    product_id,
                ),
            )
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@bp.route("/products/<int:product_id>", methods=["DELETE"])
@require_admin
def delete_product(product_id):
    with get_connection() as conn:
        row = conn.execute("SELECT photo_path FROM products WHERE id = ?", (product_id,)).fetchone()
        if row:
            _delete_image_file(row["photo_path"])
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
    return jsonify({"ok": True})


@bp.route("/products/clear", methods=["POST"])
@require_admin
def clear_products():
    with get_connection() as conn:
        rows = conn.execute("SELECT photo_path FROM products").fetchall()
        for r in rows:
            _delete_image_file(r["photo_path"])
        conn.execute("DELETE FROM products")
    return jsonify({"ok": True})


@bp.route("/products/export", methods=["GET"])
@require_admin
def export_products():
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT p.name, p.brand, p.store_type, p.category, p.unit, p.price, p.stock,
                   p.low_stock_limit, p.sku, p.hsn_code, p.notes, t.name as tax_name
            FROM products p LEFT JOIN tax_slabs t ON p.tax_slab_id = t.id
            ORDER BY p.name
            """
        ).fetchall()
    lines = ["name,brand,storeType,category,unit,price,stock,lowStockLimit,sku,hsnCode,tax,notes"]
    for r in rows:
        def esc(v):
            s = str(v if v is not None else "")
            if "," in s or '"' in s or "\n" in s:
                return '"' + s.replace('"', '""') + '"'
            return s
        lines.append(",".join([
            esc(r["name"]), esc(r["brand"]), esc(r["store_type"]), esc(r["category"]),
            esc(r["unit"]), esc(r["price"]), esc(r["stock"]), esc(r["low_stock_limit"] or ""),
            esc(r["sku"]), esc(r["hsn_code"]), esc(r["tax_name"] or ""), esc(r["notes"]),
        ]))
    csv_data = "\n".join(lines)
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=products-export.csv"},
    )


# ---------------------------------------------------------------------------
# CLIENTS
# ---------------------------------------------------------------------------

@bp.route("/clients", methods=["GET"])
@require_billing_or_admin
def list_clients():
    q = request.args.get("q", "").strip().lower()
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM clients ORDER BY created_at DESC").fetchall()
    clients = [row_to_dict(r) for r in rows]
    if q:
        clients = [
            c for c in clients
            if q in (c["name"] or "").lower()
            or q in (c["email"] or "").lower()
            or q in (c["phone"] or "").lower()
            or q in (c["gstin"] or "").lower()
        ]
    return jsonify({"ok": True, "clients": clients})


@bp.route("/clients", methods=["POST"])
@require_billing_or_admin
def create_client():
    data = _json_body()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Client name is required."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO clients (name, email, phone, address, gstin, notes) VALUES (?,?,?,?,?,?)",
            (name, data.get("email", ""), data.get("phone", ""), data.get("address", ""),
             data.get("gstin", ""), data.get("notes", "")),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/clients/<int:client_id>", methods=["PUT"])
@require_admin
def update_client(client_id):
    data = _json_body()
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not existing:
            return jsonify({"ok": False, "error": "Client not found."}), 404
        conn.execute(
            "UPDATE clients SET name=?, email=?, phone=?, address=?, gstin=?, notes=? WHERE id=?",
            (
                (data.get("name") or existing["name"]).strip(),
                data.get("email", existing["email"]),
                data.get("phone", existing["phone"]),
                data.get("address", existing["address"]),
                data.get("gstin", existing["gstin"]),
                data.get("notes", existing["notes"]),
                client_id,
            ),
        )
    return jsonify({"ok": True})


@bp.route("/clients/<int:client_id>", methods=["DELETE"])
@require_admin
def delete_client(client_id):
    with get_connection() as conn:
        conn.execute("DELETE FROM clients WHERE id = ?", (client_id,))
    return jsonify({"ok": True})


@bp.route("/clients/clear", methods=["POST"])
@require_admin
def clear_clients():
    with get_connection() as conn:
        conn.execute("DELETE FROM clients")
    return jsonify({"ok": True})


@bp.route("/clients/<int:client_id>/history", methods=["GET"])
@require_admin
def client_history(client_id):
    with get_connection() as conn:
        client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not client:
            return jsonify({"ok": False, "error": "Client not found."}), 404
        invoices = conn.execute(
            "SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC", (client_id,)
        ).fetchall()
        credit_log = conn.execute(
            "SELECT * FROM credit_transactions WHERE client_id = ? ORDER BY created_at DESC",
            (client_id,),
        ).fetchall()
        total_spent = conn.execute(
            "SELECT COALESCE(SUM(total),0) s FROM invoices WHERE client_id = ?", (client_id,)
        ).fetchone()["s"]
    return jsonify({
        "ok": True,
        "client": row_to_dict(client),
        "invoices": [row_to_dict(r) for r in invoices],
        "creditTransactions": [row_to_dict(r) for r in credit_log],
        "totalSpent": total_spent,
    })


@bp.route("/clients/<int:client_id>/credits", methods=["POST"])
@require_admin
def adjust_client_credit(client_id):
    data = _json_body()
    try:
        amount = float(data.get("amount"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Amount must be a number."}), 400
    reason = (data.get("reason") or "").strip()
    with get_connection() as conn:
        client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not client:
            return jsonify({"ok": False, "error": "Client not found."}), 404
        new_balance = client["credit_balance"] + amount
        conn.execute("UPDATE clients SET credit_balance = ? WHERE id = ?", (new_balance, client_id))
        conn.execute(
            "INSERT INTO credit_transactions (client_id, amount, reason, balance_after) VALUES (?,?,?,?)",
            (client_id, amount, reason, new_balance),
        )
    return jsonify({"ok": True, "newBalance": new_balance})


@bp.route("/clients/export", methods=["GET"])
@require_admin
def export_clients():
    with get_connection() as conn:
        rows = conn.execute("SELECT name, email, phone, address, gstin, notes, credit_balance FROM clients ORDER BY name").fetchall()
    lines = ["name,email,phone,address,gstin,notes,creditBalance"]
    for r in rows:
        def esc(v):
            s = str(v if v is not None else "")
            if "," in s or '"' in s or "\n" in s:
                return '"' + s.replace('"', '""') + '"'
            return s
        lines.append(",".join([
            esc(r["name"]), esc(r["email"]), esc(r["phone"]), esc(r["address"]),
            esc(r["gstin"]), esc(r["notes"]), esc(r["credit_balance"]),
        ]))
    return Response(
        "\n".join(lines),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=clients-export.csv"},
    )


# ---------------------------------------------------------------------------
# INVOICES
# ---------------------------------------------------------------------------

def _calc_invoice_totals(items, discount, credit_applied=0):
    subtotal = sum(float(it.get("qty", 1)) * float(it.get("price", 0)) for it in items)
    tax_amount = sum(
        float(it.get("qty", 1)) * float(it.get("price", 0)) * (float(it.get("taxPercent", it.get("tax_percent", 0)) or 0) / 100)
        for it in items
    )
    total = max(0.0, subtotal - float(discount or 0) - float(credit_applied or 0)) + tax_amount
    return subtotal, tax_amount, total


@bp.route("/invoices", methods=["GET"])
@require_billing_accountant_or_admin
def list_invoices():
    q = request.args.get("q", "").strip().lower()
    status = request.args.get("status", "").strip().lower()
    date_from = request.args.get("from", "").strip()
    date_to = request.args.get("to", "").strip()
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM invoices ORDER BY created_at DESC").fetchall()
        invoices = []
        for r in rows:
            inv = row_to_dict(r)
            items = conn.execute("SELECT * FROM invoice_items WHERE invoice_id = ?", (r["id"],)).fetchall()
            inv["items"] = [row_to_dict(i) for i in items]
            invoices.append(inv)
    # Any real invoice status (paid/unpaid/partial) can be filtered on, not
    # just paid/unpaid -- previously "partial" invoices were unreachable
    # from this filter.
    if status:
        invoices = [i for i in invoices if (i.get("status") or "").lower() == status]
    if date_from:
        invoices = [i for i in invoices if (i.get("created_at") or "") >= date_from]
    if date_to:
        invoices = [i for i in invoices if (i.get("created_at") or "") <= date_to + " 23:59:59"]
    if q:
        invoices = [
            i for i in invoices
            if q in (i.get("invoice_number") or "").lower()
            or q in (i.get("client_name") or "").lower()
        ]
    return jsonify({"ok": True, "invoices": invoices})


@bp.route("/invoices/<int:invoice_id>", methods=["GET"])
@require_billing_or_admin
def get_invoice(invoice_id):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        items = conn.execute("SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall()
        branding_rows = conn.execute("SELECT * FROM branding_settings").fetchall()
        branding = {r["key"]: r["value"] for r in branding_rows}
        layout = None
        lid = row["layout_id"] or branding.get("active_layout_id")
        if lid:
            lrow = conn.execute("SELECT * FROM invoice_layouts WHERE id = ?", (lid,)).fetchone()
            if lrow:
                layout = row_to_dict(lrow)
                layout["elements"] = json.loads(layout.pop("elements_json"))
    inv = row_to_dict(row)
    inv["items"] = [row_to_dict(i) for i in items]
    return jsonify({"ok": True, "invoice": inv, "branding": branding, "layout": layout})


@bp.route("/invoices", methods=["POST"])
@require_billing_or_admin
def create_invoice():
    data = _json_body()
    invoice_number = (data.get("invoiceNumber") or f"INV-{int(time.time())}").strip()
    client_id = data.get("clientId")
    client_name = (data.get("clientName") or "").strip()
    items = data.get("items") or []
    discount = float(data.get("discount", 0) or 0)
    credit_applied = float(data.get("creditApplied", 0) or 0)
    if not items:
        return jsonify({"ok": False, "error": "Add at least one line item."}), 400

    # uniqueness check
    with get_connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM invoices WHERE invoice_number = ?", (invoice_number,)
        ).fetchone()
        if exists:
            return jsonify({"ok": False, "error": "Invoice number already exists."}), 400

        if client_id and not client_name:
            c = conn.execute("SELECT name FROM clients WHERE id = ?", (client_id,)).fetchone()
            client_name = c["name"] if c else ""

        # apply credit from client balance if requested
        if credit_applied and client_id:
            client = conn.execute("SELECT credit_balance FROM clients WHERE id = ?", (client_id,)).fetchone()
            if client:
                avail = float(client["credit_balance"] or 0)
                credit_applied = min(credit_applied, max(0, avail))
                new_bal = avail - credit_applied
                conn.execute("UPDATE clients SET credit_balance = ? WHERE id = ?", (new_bal, client_id))
                if credit_applied:
                    conn.execute(
                        "INSERT INTO credit_transactions (client_id, amount, reason, balance_after) VALUES (?,?,?,?)",
                        (client_id, -credit_applied, f"Applied to invoice {invoice_number}", new_bal),
                    )

        subtotal, tax_amount, total = _calc_invoice_totals(items, discount, credit_applied)

        # active layout if not provided
        layout_id = data.get("layoutId")
        if not layout_id:
            s = conn.execute("SELECT value FROM branding_settings WHERE key = 'active_layout_id'").fetchone()
            layout_id = int(s["value"]) if s and s["value"] else None

        cur = conn.execute(
            """
            INSERT INTO invoices (invoice_number, client_id, client_name, subtotal, discount,
                tax_amount, total, credit_applied, status, notes, layout_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (invoice_number, client_id, client_name, subtotal, discount, tax_amount, total,
             credit_applied, data.get("status", "unpaid"), data.get("notes", ""), layout_id),
        )
        invoice_id = cur.lastrowid
        for it in items:
            conn.execute(
                "INSERT INTO invoice_items (invoice_id, product_id, name, qty, price, tax_percent) VALUES (?,?,?,?,?,?)",
                (invoice_id, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                 it.get("price", 0), it.get("taxPercent", 0)),
            )
        # deduct stock
        _deduct_invoice_stock(conn, items)

        # optional amount paid at create (billing counter)
        amount_paid = float(data.get("amountPaid", 0) or 0)
        status = data.get("status", "unpaid")
        if status == "paid" and amount_paid <= 0:
            amount_paid = total
        if amount_paid > 0:
            amount_paid = min(amount_paid, total)
            st = "paid" if amount_paid + 0.001 >= total else "partial"
            conn.execute(
                "UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?",
                (amount_paid, st, invoice_id),
            )
            if amount_paid:
                conn.execute(
                    "INSERT INTO payments (invoice_id, amount, method, reference, notes) VALUES (?,?,?,?,?)",
                    (invoice_id, amount_paid, data.get("paymentMethod", "cash"), "", "At sale"),
                )
    return jsonify({"ok": True, "id": invoice_id, "total": total, "amountPaid": amount_paid if amount_paid else 0})


@bp.route("/invoices/<int:invoice_id>", methods=["PUT"])
@require_admin
def update_invoice(invoice_id):
    data = _json_body()
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not existing:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404

        # restore previous stock before replacing items
        items = data.get("items")
        if items is not None:
            _restore_invoice_stock(conn, invoice_id)
            conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))
            for it in items:
                conn.execute(
                    "INSERT INTO invoice_items (invoice_id, product_id, name, qty, price, tax_percent) VALUES (?,?,?,?,?,?)",
                    (invoice_id, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                     it.get("price", 0), it.get("taxPercent", 0)),
                )
            _deduct_invoice_stock(conn, items)
        else:
            item_rows = conn.execute("SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall()
            items = [dict(r) for r in item_rows]

        discount = float(data.get("discount", existing["discount"]) or 0)
        credit_applied = float(data.get("creditApplied", existing["credit_applied"] if "credit_applied" in existing.keys() else 0) or 0)
        subtotal, tax_amount, total = _calc_invoice_totals(items, discount, credit_applied)

        layout_id = data.get("layoutId", existing["layout_id"])

        conn.execute(
            """
            UPDATE invoices SET invoice_number=?, client_name=?, client_id=?, subtotal=?, discount=?,
                tax_amount=?, total=?, credit_applied=?, status=?, notes=?, layout_id=? WHERE id=?
            """,
            (
                data.get("invoiceNumber", existing["invoice_number"]),
                data.get("clientName", existing["client_name"]),
                data.get("clientId", existing["client_id"]),
                subtotal, discount, tax_amount, total, credit_applied,
                data.get("status", existing["status"]),
                data.get("notes", existing["notes"]),
                layout_id,
                invoice_id,
            ),
        )
    return jsonify({"ok": True, "total": total})


@bp.route("/invoices/<int:invoice_id>/status", methods=["POST"])
@require_billing_or_admin
def set_invoice_status(invoice_id):
    data = _json_body()
    status = (data.get("status") or "").strip().lower()
    if status not in ("paid", "unpaid", "partial"):
        return jsonify({"ok": False, "error": "Status must be paid, unpaid, or partial."}), 400
    with get_connection() as conn:
        inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        total = float(inv["total"] or 0)
        if status == "paid":
            amount_paid = total
        elif status == "unpaid":
            amount_paid = 0
        else:
            amount_paid = float(data.get("amountPaid", inv["amount_paid"] or 0) or 0)
            amount_paid = min(max(0, amount_paid), total)
            status = "paid" if amount_paid + 0.001 >= total else ("unpaid" if amount_paid <= 0 else "partial")
        conn.execute("UPDATE invoices SET status = ?, amount_paid = ? WHERE id = ?", (status, amount_paid, invoice_id))
        if status == "paid" and amount_paid > 0:
            existing = conn.execute("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?", (invoice_id,)).fetchone()["s"]
            if float(existing or 0) + 0.001 < amount_paid:
                conn.execute(
                    "INSERT INTO payments (invoice_id, amount, method, reference, notes) VALUES (?,?,?,?,?)",
                    (invoice_id, amount_paid - float(existing or 0), data.get("method", "cash"), "", "Status update"),
                )
    return jsonify({"ok": True, "status": status, "amountPaid": amount_paid})



@bp.route("/invoices/<int:invoice_id>", methods=["DELETE"])
@require_admin
def delete_invoice(invoice_id):
    with get_connection() as conn:
        # restore stock
        _restore_invoice_stock(conn, invoice_id)
        conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))
        conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
    return jsonify({"ok": True})


@bp.route("/invoices/clear", methods=["POST"])
@require_admin
def clear_invoices():
    with get_connection() as conn:
        # restore all stock first
        invs = conn.execute("SELECT id FROM invoices").fetchall()
        for inv in invs:
            _restore_invoice_stock(conn, inv["id"])
        conn.execute("DELETE FROM invoice_items")
        conn.execute("DELETE FROM invoices")
    return jsonify({"ok": True})


@bp.route("/invoices/export", methods=["GET"])
@require_admin
def export_invoices():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT invoice_number, client_name, subtotal, discount, tax_amount, total, credit_applied, status, notes, created_at FROM invoices ORDER BY created_at DESC"
        ).fetchall()
    lines = ["invoiceNumber,clientName,subtotal,discount,tax,total,creditApplied,status,notes,date"]
    for r in rows:
        def esc(v):
            s = str(v if v is not None else "")
            if "," in s or '"' in s or "\n" in s:
                return '"' + s.replace('"', '""') + '"'
            return s
        lines.append(",".join([
            esc(r["invoice_number"]), esc(r["client_name"]), esc(r["subtotal"]),
            esc(r["discount"]), esc(r["tax_amount"]), esc(r["total"]),
            esc(r["credit_applied"] if "credit_applied" in r.keys() else 0),
            esc(r["status"]), esc(r["notes"]), esc(r["created_at"]),
        ]))
    return Response(
        "\n".join(lines),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=invoices-export.csv"},
    )


# ---------------------------------------------------------------------------
# BRANDING
# ---------------------------------------------------------------------------

@bp.route("/branding", methods=["GET"])
@require_billing_accountant_or_admin
def get_branding():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM branding_settings").fetchall()
    return jsonify({"ok": True, "branding": {r["key"]: r["value"] for r in rows}})


@bp.route("/branding", methods=["POST"])
@require_admin
def save_branding():
    fields = [
        "brand_name", "brand_tagline", "brand_address", "brand_email", "brand_phone",
        "accent_color", "footer_note", "show_techserenia_logo", "show_orbitbills_branding",
        "active_layout_id", "default_low_stock_limit", "currency_symbol", "price_override_pin", "allow_price_override", "max_discount_pct",
        "upi_id", "upi_name", "payment_link_note",
    ]
    with get_connection() as conn:
        for key in fields:
            if _is_multipart():
                value = request.form.get(key)
            else:
                value = _json_body().get(key)
            if value is not None:
                conn.execute(
                    "INSERT INTO branding_settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, value),
                )
        if _is_multipart() and "brandLogo" in request.files and request.files["brandLogo"].filename:
            try:
                # delete previous custom logo
                old = conn.execute("SELECT value FROM branding_settings WHERE key = 'custom_brand_logo'").fetchone()
                if old:
                    _delete_image_file(old["value"])
                path = _save_image(request.files["brandLogo"], "branding")
                conn.execute(
                    "INSERT INTO branding_settings (key, value) VALUES ('custom_brand_logo', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (path,),
                )
            except ValueError as e:
                return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# INVOICE LAYOUTS
# ---------------------------------------------------------------------------

@bp.route("/invoice-layouts", methods=["GET"])
@require_admin
def list_layouts():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM invoice_layouts ORDER BY is_preset DESC, created_at ASC").fetchall()
    layouts = []
    for r in rows:
        d = row_to_dict(r)
        d["elements"] = json.loads(d.pop("elements_json"))
        layouts.append(d)
    return jsonify({"ok": True, "layouts": layouts})


@bp.route("/invoice-layouts", methods=["POST"])
@require_admin
def create_layout():
    data = _json_body()
    name = (data.get("name") or "Custom layout").strip()
    elements = data.get("elements")
    if not elements or not isinstance(elements, list):
        return jsonify({"ok": False, "error": "elements must be a list of canvas items."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO invoice_layouts (name, is_preset, elements_json) VALUES (?, 0, ?)",
            (name, json.dumps(elements)),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/invoice-layouts/<int:layout_id>", methods=["PUT"])
@require_admin
def update_layout(layout_id):
    data = _json_body()
    elements = data.get("elements")
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM invoice_layouts WHERE id = ?", (layout_id,)).fetchone()
        if not existing:
            return jsonify({"ok": False, "error": "Layout not found."}), 404
        if existing["is_preset"]:
            return jsonify({"ok": False, "error": "Preset layouts cannot be overwritten. Save as a new custom layout instead."}), 400
        conn.execute(
            "UPDATE invoice_layouts SET name=?, elements_json=? WHERE id=?",
            (
                data.get("name", existing["name"]),
                json.dumps(elements) if elements is not None else existing["elements_json"],
                layout_id,
            ),
        )
    return jsonify({"ok": True})


@bp.route("/invoice-layouts/<int:layout_id>", methods=["DELETE"])
@require_admin
def delete_layout(layout_id):
    with get_connection() as conn:
        row = conn.execute("SELECT is_preset FROM invoice_layouts WHERE id = ?", (layout_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Layout not found."}), 404
        if row["is_preset"]:
            return jsonify({"ok": False, "error": "Preset layouts can't be deleted."}), 400
        conn.execute("DELETE FROM invoice_layouts WHERE id = ?", (layout_id,))
        # if this was the active layout, clear it
        active = conn.execute("SELECT value FROM branding_settings WHERE key = 'active_layout_id'").fetchone()
        if active and str(active["value"]) == str(layout_id):
            first = conn.execute("SELECT id FROM invoice_layouts ORDER BY id LIMIT 1").fetchone()
            conn.execute(
                "UPDATE branding_settings SET value = ? WHERE key = 'active_layout_id'",
                (str(first["id"]) if first else "",),
            )
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# USERS
# ---------------------------------------------------------------------------

@bp.route("/users", methods=["GET"])
@require_admin
def get_users():
    return jsonify({"ok": True, "users": database.list_users()})


@bp.route("/users", methods=["POST"])
@require_admin
def add_user():
    data = _json_body()
    user, error = database.create_user(
        data.get("name", ""), data.get("email", ""), data.get("password", ""), data.get("role", "")
    )
    if error:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True, "user": user})


@bp.route("/users/<int:user_id>", methods=["DELETE"])
@require_admin
def remove_user(user_id):
    u = database.get_user_by_id(user_id)
    if u and session.get("email") and u["email"] == session.get("email"):
        return jsonify({"ok": False, "error": "You can't delete the account you're signed in as."}), 400
    ok = database.delete_user(user_id)
    if not ok:
        return jsonify({"ok": False, "error": "User not found."}), 404
    return jsonify({"ok": True})


@bp.route("/users/<int:user_id>/password", methods=["POST"])
@require_admin
def reset_password(user_id):
    data = _json_body()
    ok, error = database.update_user_password(user_id, data.get("password", ""))
    if not ok:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True})


@bp.route("/users/<int:user_id>/role", methods=["POST"])
@require_admin
def change_role(user_id):
    data = _json_body()
    ok, error = database.update_user_role(user_id, data.get("role", ""))
    if not ok:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# EMAIL (SMTP credentials come from the client / IndexedDB — never stored server-side)
# ---------------------------------------------------------------------------

@bp.route("/email/send", methods=["POST"])
@require_admin
def send_email():
    """
    Body:
      smtp: { host, port, user, password, useTls, fromEmail, fromName }
      to: email
      subject: str
      body: str (plain or html)
      html: bool
    """
    data = _json_body()
    smtp = data.get("smtp") or {}
    to = (data.get("to") or "").strip()
    subject = (data.get("subject") or "").strip()
    body = data.get("body") or ""
    is_html = bool(data.get("html"))

    host = (smtp.get("host") or "").strip()
    port = int(smtp.get("port") or 587)
    user = (smtp.get("user") or "").strip()
    password = smtp.get("password") or ""
    use_tls = smtp.get("useTls", True)
    from_email = (smtp.get("fromEmail") or user or "").strip()
    from_name = (smtp.get("fromName") or "OrbitBills").strip()

    if not host or not to or not subject:
        return jsonify({"ok": False, "error": "SMTP host, recipient, and subject are required."}), 400
    if not from_email:
        return jsonify({"ok": False, "error": "From email is required in SMTP settings."}), 400

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{from_name} <{from_email}>"
        msg["To"] = to
        subtype = "html" if is_html else "plain"
        msg.attach(MIMEText(body, subtype, "utf-8"))

        with smtplib.SMTP(host, port, timeout=20) as server:
            if use_tls:
                server.starttls()
            if user and password:
                server.login(user, password)
            server.sendmail(from_email, [to], msg.as_string())
    except Exception as e:
        return jsonify({"ok": False, "error": f"Email failed: {str(e)}"}), 400

    return jsonify({"ok": True})


@bp.route("/email/test", methods=["POST"])
@require_admin
def test_email():
    data = _json_body()
    smtp = data.get("smtp") or {}
    to = (data.get("to") or smtp.get("fromEmail") or smtp.get("user") or "").strip()
    data["to"] = to
    data["subject"] = data.get("subject") or "OrbitBills test email"
    data["body"] = data.get("body") or "This is a test message from your TechSerenia OrbitBills admin panel. SMTP settings are working."
    data["html"] = False
    return send_email()


# ---------------------------------------------------------------------------
# BACKUP & RESTORE (includes images as base64)
# ---------------------------------------------------------------------------

def _file_to_b64(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except OSError:
        return None


def _b64_to_file(b64, dest_path):
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, "wb") as f:
        f.write(base64.b64decode(b64))


@bp.route("/backup", methods=["GET"])
@require_admin
def create_backup():
    """Return a full JSON backup including product/branding images as base64."""
    with get_connection() as conn:
        tables = {}
        for table in ("tax_slabs", "products", "clients", "credit_transactions",
                      "invoices", "invoice_items", "branding_settings", "invoice_layouts",
                      "suppliers", "purchases", "purchase_items", "inventory_movements", "invoice_share_tokens"):
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            tables[table] = [row_to_dict(r) for r in rows]

    # embed images
    images = {"products": {}, "branding": {}}
    for p in tables.get("products", []):
        pp = p.get("photo_path")
        if pp and pp.startswith("/uploads/products/"):
            fname = pp.rsplit("/", 1)[-1]
            full = os.path.join(PRODUCT_UPLOAD_DIR, secure_filename(fname))
            b64 = _file_to_b64(full)
            if b64:
                images["products"][fname] = b64
    for row in tables.get("branding_settings", []):
        if row.get("key") == "custom_brand_logo":
            pp = row.get("value") or ""
            if pp.startswith("/uploads/branding/"):
                fname = pp.rsplit("/", 1)[-1]
                full = os.path.join(BRANDING_UPLOAD_DIR, secure_filename(fname))
                b64 = _file_to_b64(full)
                if b64:
                    images["branding"][fname] = b64

    payload = {
        "version": 1,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "app": "OrbitBills / TechSerenia",
        "tables": tables,
        "images": images,
    }
    data = json.dumps(payload, indent=2)
    return Response(
        data,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename=orbitbills-backup-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"},
    )


@bp.route("/restore", methods=["POST"])
@require_admin
def restore_backup():
    """
    Accepts JSON body = backup object, or multipart with a .json file.
    Replaces all admin data (products, clients, invoices, tax, branding, layouts).
    Does NOT touch the users auth table.
    """
    if _is_multipart() and "backup" in request.files:
        raw = request.files["backup"].read()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return jsonify({"ok": False, "error": "Invalid backup file."}), 400
    else:
        payload = _json_body()

    if not payload or "tables" not in payload:
        return jsonify({"ok": False, "error": "Invalid backup format."}), 400

    tables = payload["tables"]
    images = payload.get("images") or {}

    # wipe image dirs for products/branding then restore
    for folder in (PRODUCT_UPLOAD_DIR, BRANDING_UPLOAD_DIR):
        if os.path.isdir(folder):
            for name in os.listdir(folder):
                try:
                    os.remove(os.path.join(folder, name))
                except OSError:
                    pass

    # write images back
    for fname, b64 in (images.get("products") or {}).items():
        _b64_to_file(b64, os.path.join(PRODUCT_UPLOAD_DIR, secure_filename(fname)))
    for fname, b64 in (images.get("branding") or {}).items():
        _b64_to_file(b64, os.path.join(BRANDING_UPLOAD_DIR, secure_filename(fname)))

    with get_connection() as conn:
        # clear existing admin tables (order matters for FKs)
        for table in ("purchase_items", "purchases", "suppliers", "inventory_movements", "invoice_share_tokens",
                      "invoice_items", "invoices", "credit_transactions", "clients",
                      "products", "tax_slabs", "branding_settings", "invoice_layouts"):
            conn.execute(f"DELETE FROM {table}")

        # restore tax_slabs
        for r in tables.get("tax_slabs") or []:
            conn.execute(
                "INSERT INTO tax_slabs (id, name, percentage, is_default, created_at) VALUES (?,?,?,?,?)",
                (r.get("id"), r.get("name"), r.get("percentage"), r.get("is_default", 0), r.get("created_at")),
            )

        for r in tables.get("products") or []:
            conn.execute(
                """
                INSERT INTO products (id, name, brand, store_type, category, unit, price, stock,
                    low_stock_limit, tax_slab_id, sku, hsn_code, notes, photo_path, color, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (r.get("id"), r.get("name"), r.get("brand"), r.get("store_type"), r.get("category"),
                 r.get("unit"), r.get("price"), r.get("stock"), r.get("low_stock_limit"),
                 r.get("tax_slab_id"), r.get("sku"), r.get("hsn_code"), r.get("notes"),
                 r.get("photo_path"), r.get("color"), r.get("created_at"), r.get("updated_at")),
            )

        for r in tables.get("clients") or []:
            conn.execute(
                """
                INSERT INTO clients (id, name, email, phone, address, gstin, notes, credit_balance, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (r.get("id"), r.get("name"), r.get("email"), r.get("phone"), r.get("address"),
                 r.get("gstin"), r.get("notes"), r.get("credit_balance", 0), r.get("created_at")),
            )

        for r in tables.get("credit_transactions") or []:
            conn.execute(
                """
                INSERT INTO credit_transactions (id, client_id, amount, reason, balance_after, created_at)
                VALUES (?,?,?,?,?,?)
                """,
                (r.get("id"), r.get("client_id"), r.get("amount"), r.get("reason"),
                 r.get("balance_after"), r.get("created_at")),
            )

        for r in tables.get("invoices") or []:
            conn.execute(
                """
                INSERT INTO invoices (id, invoice_number, client_id, client_name, subtotal, discount,
                    tax_amount, total, credit_applied, status, notes, layout_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (r.get("id"), r.get("invoice_number"), r.get("client_id"), r.get("client_name"),
                 r.get("subtotal"), r.get("discount"), r.get("tax_amount"), r.get("total"),
                 r.get("credit_applied", 0), r.get("status"), r.get("notes"),
                 r.get("layout_id"), r.get("created_at")),
            )

        for r in tables.get("invoice_items") or []:
            conn.execute(
                """
                INSERT INTO invoice_items (id, invoice_id, product_id, name, qty, price, tax_percent)
                VALUES (?,?,?,?,?,?,?)
                """,
                (r.get("id"), r.get("invoice_id"), r.get("product_id"), r.get("name"),
                 r.get("qty"), r.get("price"), r.get("tax_percent")),
            )

        for r in tables.get("branding_settings") or []:
            conn.execute(
                "INSERT INTO branding_settings (key, value) VALUES (?, ?)",
                (r.get("key"), r.get("value")),
            )

        for r in tables.get("invoice_layouts") or []:
            elements = r.get("elements_json")
            if elements is None and "elements" in r:
                elements = json.dumps(r["elements"])
            conn.execute(
                "INSERT INTO invoice_layouts (id, name, is_preset, elements_json, created_at) VALUES (?,?,?,?,?)",
                (r.get("id"), r.get("name"), r.get("is_preset", 0), elements, r.get("created_at")),
            )


        for r in tables.get("suppliers") or []:
            conn.execute(
                "INSERT INTO suppliers (id, name, email, phone, address, gstin, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (r.get("id"), r.get("name"), r.get("email"), r.get("phone"), r.get("address"),
                 r.get("gstin"), r.get("notes"), r.get("created_at")),
            )
        for r in tables.get("purchases") or []:
            conn.execute(
                """INSERT INTO purchases (id, purchase_number, supplier_id, supplier_name, subtotal, tax_amount, total, status, notes, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (r.get("id"), r.get("purchase_number"), r.get("supplier_id"), r.get("supplier_name"),
                 r.get("subtotal"), r.get("tax_amount"), r.get("total"), r.get("status"), r.get("notes"), r.get("created_at")),
            )
        for r in tables.get("purchase_items") or []:
            conn.execute(
                "INSERT INTO purchase_items (id, purchase_id, product_id, name, qty, cost, tax_percent) VALUES (?,?,?,?,?,?,?)",
                (r.get("id"), r.get("purchase_id"), r.get("product_id"), r.get("name"), r.get("qty"), r.get("cost"), r.get("tax_percent")),
            )
        for r in tables.get("inventory_movements") or []:
            conn.execute(
                """INSERT INTO inventory_movements (id, product_id, product_name, delta, reason, ref_type, ref_id, balance_after, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (r.get("id"), r.get("product_id"), r.get("product_name"), r.get("delta"), r.get("reason"),
                 r.get("ref_type"), r.get("ref_id"), r.get("balance_after"), r.get("created_at")),
            )
        for r in tables.get("invoice_share_tokens") or []:
            conn.execute(
                "INSERT INTO invoice_share_tokens (token, invoice_id, created_at) VALUES (?,?,?)",
                (r.get("token"), r.get("invoice_id"), r.get("created_at")),
            )

    return jsonify({"ok": True, "message": "Backup restored successfully."})



# ---------------------------------------------------------------------------
# SUPPLIERS
# ---------------------------------------------------------------------------

@bp.route("/suppliers", methods=["GET"])
@require_admin
def list_suppliers():
    q = request.args.get("q", "").strip().lower()
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM suppliers ORDER BY created_at DESC").fetchall()
    suppliers = [row_to_dict(r) for r in rows]
    if q:
        suppliers = [s for s in suppliers if q in (s["name"] or "").lower() or q in (s["phone"] or "").lower()]
    return jsonify({"ok": True, "suppliers": suppliers})


@bp.route("/suppliers", methods=["POST"])
@require_admin
def create_supplier():
    data = _json_body()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Supplier name is required."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO suppliers (name, email, phone, address, gstin, notes) VALUES (?,?,?,?,?,?)",
            (name, data.get("email", ""), data.get("phone", ""), data.get("address", ""),
             data.get("gstin", ""), data.get("notes", "")),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/suppliers/<int:sid>", methods=["PUT"])
@require_admin
def update_supplier(sid):
    data = _json_body()
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM suppliers WHERE id = ?", (sid,)).fetchone()
        if not existing:
            return jsonify({"ok": False, "error": "Supplier not found."}), 404
        conn.execute(
            "UPDATE suppliers SET name=?, email=?, phone=?, address=?, gstin=?, notes=? WHERE id=?",
            (
                (data.get("name") or existing["name"]).strip(),
                data.get("email", existing["email"]),
                data.get("phone", existing["phone"]),
                data.get("address", existing["address"]),
                data.get("gstin", existing["gstin"]),
                data.get("notes", existing["notes"]),
                sid,
            ),
        )
    return jsonify({"ok": True})


@bp.route("/suppliers/<int:sid>", methods=["DELETE"])
@require_admin
def delete_supplier(sid):
    with get_connection() as conn:
        conn.execute("DELETE FROM suppliers WHERE id = ?", (sid,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# PURCHASES
# ---------------------------------------------------------------------------

@bp.route("/purchases", methods=["GET"])
@require_admin
def list_purchases():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM purchases ORDER BY created_at DESC").fetchall()
        purchases = []
        for r in rows:
            p = row_to_dict(r)
            items = conn.execute("SELECT * FROM purchase_items WHERE purchase_id = ?", (r["id"],)).fetchall()
            p["items"] = [row_to_dict(i) for i in items]
            purchases.append(p)
    return jsonify({"ok": True, "purchases": purchases})


@bp.route("/purchases", methods=["POST"])
@require_admin
def create_purchase():
    data = _json_body()
    purchase_number = (data.get("purchaseNumber") or f"PO-{int(time.time())}").strip()
    supplier_id = data.get("supplierId")
    supplier_name = (data.get("supplierName") or "").strip()
    items = data.get("items") or []
    if not items:
        return jsonify({"ok": False, "error": "Add at least one line item."}), 400

    subtotal = sum(float(it.get("qty", 1)) * float(it.get("cost", 0)) for it in items)
    tax_amount = sum(
        float(it.get("qty", 1)) * float(it.get("cost", 0)) * (float(it.get("taxPercent", 0)) / 100)
        for it in items
    )
    total = subtotal + tax_amount

    with get_connection() as conn:
        if supplier_id and not supplier_name:
            s = conn.execute("SELECT name FROM suppliers WHERE id = ?", (supplier_id,)).fetchone()
            supplier_name = s["name"] if s else ""
        cur = conn.execute(
            """
            INSERT INTO purchases (purchase_number, supplier_id, supplier_name, subtotal, tax_amount, total, status, notes)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (purchase_number, supplier_id, supplier_name, subtotal, tax_amount, total,
             data.get("status", "received"), data.get("notes", "")),
        )
        purchase_id = cur.lastrowid
        for it in items:
            conn.execute(
                "INSERT INTO purchase_items (purchase_id, product_id, name, qty, cost, tax_percent) VALUES (?,?,?,?,?,?)",
                (purchase_id, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                 it.get("cost", 0), it.get("taxPercent", 0)),
            )
            pid = it.get("productId")
            qty = int(float(it.get("qty", 1) or 1))
            if pid and data.get("status", "received") == "received":
                _adjust_stock(conn, pid, qty, reason="Purchase " + purchase_number, ref_type="purchase", ref_id=purchase_id)
                # optionally update cost_price
                if it.get("cost") is not None:
                    conn.execute("UPDATE products SET cost_price = ? WHERE id = ?", (float(it["cost"]), pid))
    return jsonify({"ok": True, "id": purchase_id, "total": total})


@bp.route("/purchases/<int:pid>", methods=["DELETE"])
@require_admin
def delete_purchase(pid):
    with get_connection() as conn:
        # reverse stock if received
        row = conn.execute("SELECT * FROM purchases WHERE id = ?", (pid,)).fetchone()
        if row and row["status"] == "received":
            items = conn.execute("SELECT * FROM purchase_items WHERE purchase_id = ?", (pid,)).fetchall()
            for it in items:
                if it["product_id"]:
                    _adjust_stock(conn, it["product_id"], -int(float(it["qty"] or 0)),
                                  reason="Delete purchase " + (row["purchase_number"] or ""),
                                  ref_type="purchase", ref_id=pid)
        conn.execute("DELETE FROM purchase_items WHERE purchase_id = ?", (pid,))
        conn.execute("DELETE FROM purchases WHERE id = ?", (pid,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# INVOICE SHARE LINKS (public)
# ---------------------------------------------------------------------------

@bp.route("/invoices/<int:invoice_id>/share", methods=["POST"])
@require_billing_or_admin
def create_share_link(invoice_id):
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        existing = conn.execute(
            "SELECT token FROM invoice_share_tokens WHERE invoice_id = ?", (invoice_id,)
        ).fetchone()
        if existing:
            token = existing["token"]
        else:
            token = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO invoice_share_tokens (token, invoice_id) VALUES (?, ?)",
                (token, invoice_id),
            )
    return jsonify({"ok": True, "token": token, "path": f"/share/invoice/{token}"})


# Public blueprint-style route on uploads_bp for no-auth access

@uploads_bp.route("/share/invoice/<token>")
def public_invoice_share(token):
    with get_connection() as conn:
        link = conn.execute(
            "SELECT invoice_id FROM invoice_share_tokens WHERE token = ?", (token,)
        ).fetchone()
        if not link:
            return jsonify({"ok": False, "error": "Invalid or expired link."}), 404
        invoice_id = link["invoice_id"]
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        items = conn.execute("SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall()
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
    inv = row_to_dict(row)
    inv["items"] = [row_to_dict(i) for i in items]
    brand = branding.get("brand_name") or "OrbitBills"
    accent = branding.get("accent_color") or "#0b3d91"
    total = float(inv.get("total") or 0)
    paid = float(inv.get("amount_paid") or 0)
    due = max(0.0, total - paid)
    upi_id = branding.get("upi_id") or ""
    upi_name = branding.get("upi_name") or brand
    from urllib.parse import quote
    import json as _json
    upi_link = ""
    if upi_id and due > 0:
        upi_link = (
            "upi://pay?pa=" + quote(upi_id)
            + "&pn=" + quote(upi_name)
            + "&am=" + ("%.2f" % due)
            + "&cu=INR&tn=" + quote("Invoice " + str(inv.get("invoice_number", "")))
        )
    items_html = "".join(
        "<tr><td>%s</td><td>%s</td><td>%.2f</td><td>%.2f</td></tr>"
        % (_esc(i["name"]), i["qty"], float(i["price"]), float(i["qty"]) * float(i["price"]))
        for i in inv["items"]
    )
    pay_block = ""
    if upi_id and due > 0:
        pay_block = (
            '<div class="pay"><h2>Pay online</h2>'
            '<p>Amount due: <strong>%.2f</strong></p>'
            '<p>UPI: %s</p>'
            '<p><a class="btn" href="%s">Open UPI app</a></p>'
            '<p class="hint">%s</p>'
            '<div id="upiQr"></div>'
            '<p class="wm">OrbitBills Powered By TechSerenia</p></div>'
            '<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>'
            '<script>(async function(){var el=document.getElementById("upiQr");if(!window.QRCode)return;'
            'var c=document.createElement("canvas");'
            'await QRCode.toCanvas(c,%s,{width:180,margin:2});'
            'var ctx=c.getContext("2d");ctx.fillStyle="rgba(11,61,145,0.55)";'
            'ctx.font="bold 9px sans-serif";ctx.textAlign="center";'
            'ctx.fillText("OrbitBills",c.width/2,c.height-18);'
            'ctx.fillText("Powered By TechSerenia",c.width/2,c.height-7);'
            'el.appendChild(c);})();</script>'
        ) % (
            due,
            _esc(upi_id),
            _esc(upi_link),
            _esc(branding.get("payment_link_note") or ""),
            _json.dumps(upi_link),
        )
    html = (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Invoice %s — %s</title>"
        "<style>"
        "body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#101a2b}"
        "h1{color:%s;font-size:22px;margin:0 0 4px}"
        ".meta{color:#5b6b82;font-size:14px;margin-bottom:20px}"
        "table{width:100%%;border-collapse:collapse;font-size:14px}"
        "th,td{padding:8px;border-bottom:1px solid #dfe7f5;text-align:left}"
        "th{font-size:12px;color:#5b6b82;text-transform:uppercase}"
        ".total{font-size:20px;font-weight:700;color:%s;text-align:right;margin-top:16px}"
        ".pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;background:#eaf1fc;color:%s}"
        ".pay{margin-top:28px;padding:18px;border:1px solid #dfe7f5;border-radius:12px;background:#f5f8fe}"
        ".pay h2{font-size:16px;margin:0 0 8px}"
        ".btn{display:inline-block;background:%s;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}"
        ".hint{font-size:12px;color:#5b6b82}.wm{font-size:10px;color:#0b3d91;font-weight:700;margin-top:8px}"
        "#upiQr{margin-top:12px}"
        "</style></head><body>"
        "<h1>%s</h1>"
        "<div class=\"meta\">Invoice <strong>%s</strong> · <span class=\"pill\">%s</span> · Client: %s</div>"
        "<table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead>"
        "<tbody>%s</tbody></table>"
        "<div class=\"total\">Total: %.2f</div>"
        "<p style=\"text-align:right;color:#5b6b82;font-size:13px\">Paid: %.2f · Due: %.2f</p>"
        "%s"
        "<p style=\"color:#5b6b82;font-size:12px;margin-top:32px\">%s</p>"
        "<p class=\"wm\" style=\"text-align:center;margin-top:24px\">OrbitBills Powered By TechSerenia</p>"
        "</body></html>"
    ) % (
        _esc(inv.get("invoice_number", "")),
        _esc(brand),
        accent, accent, accent, accent,
        _esc(brand),
        _esc(inv.get("invoice_number", "")),
        _esc(inv.get("status", "")),
        _esc(inv.get("client_name", "")),
        items_html,
        total, paid, due,
        pay_block,
        _esc(branding.get("footer_note") or ""),
    )
    return html



def _esc(s):
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ---------------------------------------------------------------------------
# BULK ACTIONS
# ---------------------------------------------------------------------------

@bp.route("/products/bulk-delete", methods=["POST"])
@require_admin
def bulk_delete_products():
    data = _json_body()
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": False, "error": "No ids provided."}), 400
    with get_connection() as conn:
        for pid in ids:
            row = conn.execute("SELECT photo_path FROM products WHERE id = ?", (pid,)).fetchone()
            if row:
                _delete_image_file(row["photo_path"])
            conn.execute("DELETE FROM products WHERE id = ?", (pid,))
    return jsonify({"ok": True, "deleted": len(ids)})


@bp.route("/clients/bulk-delete", methods=["POST"])
@require_admin
def bulk_delete_clients():
    data = _json_body()
    ids = data.get("ids") or []
    with get_connection() as conn:
        for cid in ids:
            conn.execute("DELETE FROM clients WHERE id = ?", (cid,))
    return jsonify({"ok": True, "deleted": len(ids)})


@bp.route("/invoices/bulk-status", methods=["POST"])
@require_admin
def bulk_invoice_status():
    data = _json_body()
    ids = data.get("ids") or []
    status = (data.get("status") or "").strip().lower()
    if status not in ("paid", "unpaid") or not ids:
        return jsonify({"ok": False, "error": "ids and status (paid/unpaid) required."}), 400
    with get_connection() as conn:
        for iid in ids:
            conn.execute("UPDATE invoices SET status = ? WHERE id = ?", (status, iid))
    return jsonify({"ok": True, "updated": len(ids)})


@bp.route("/invoices/bulk-delete", methods=["POST"])
@require_admin
def bulk_delete_invoices():
    data = _json_body()
    ids = data.get("ids") or []
    with get_connection() as conn:
        for iid in ids:
            _restore_invoice_stock(conn, iid)
            conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (iid,))
            conn.execute("DELETE FROM invoices WHERE id = ?", (iid,))
            conn.execute("DELETE FROM invoice_share_tokens WHERE invoice_id = ?", (iid,))
    return jsonify({"ok": True, "deleted": len(ids)})


# ---------------------------------------------------------------------------
# DASHBOARD CHARTS + MARGINS + LOW STOCK ALERTS
# ---------------------------------------------------------------------------

@bp.route("/analytics", methods=["GET"])
@require_admin
def analytics():
    with get_connection() as conn:
        # revenue by month (last 6)
        monthly = conn.execute(
            """
            SELECT substr(created_at, 1, 7) as month,
                   SUM(CASE WHEN status='paid' THEN total ELSE 0 END) as paid,
                   SUM(CASE WHEN status='unpaid' THEN total ELSE 0 END) as unpaid,
                   COUNT(*) as count
            FROM invoices
            GROUP BY substr(created_at, 1, 7)
            ORDER BY month DESC
            LIMIT 6
            """
        ).fetchall()
        # top products by qty sold
        top_products = conn.execute(
            """
            SELECT name, SUM(qty) as qty, SUM(qty * price) as revenue
            FROM invoice_items
            GROUP BY name
            ORDER BY qty DESC
            LIMIT 8
            """
        ).fetchall()
        # top clients
        top_clients = conn.execute(
            """
            SELECT client_name as name, SUM(total) as revenue, COUNT(*) as invoices
            FROM invoices
            WHERE client_name IS NOT NULL AND client_name != ''
            GROUP BY client_name
            ORDER BY revenue DESC
            LIMIT 8
            """
        ).fetchall()
        # margin estimate: invoice items joined to products cost
        margin_rows = conn.execute(
            """
            SELECT ii.name, SUM(ii.qty * ii.price) as revenue,
                   SUM(ii.qty * COALESCE(p.cost_price, 0)) as cost
            FROM invoice_items ii
            LEFT JOIN products p ON ii.product_id = p.id
            GROUP BY ii.name
            ORDER BY revenue DESC
            LIMIT 20
            """
        ).fetchall()
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        low = conn.execute(
            """
            SELECT id, name, stock, low_stock_limit, cost_price, price
            FROM products
            WHERE stock <= COALESCE(low_stock_limit, ?)
            ORDER BY stock ASC
            """,
            (default_limit,),
        ).fetchall()

    margins = []
    for r in margin_rows:
        rev = float(r["revenue"] or 0)
        cost = float(r["cost"] or 0)
        margins.append({
            "name": r["name"],
            "revenue": rev,
            "cost": cost,
            "profit": rev - cost,
            "marginPct": round(((rev - cost) / rev * 100) if rev else 0, 1),
        })

    return jsonify({
        "ok": True,
        "monthly": [row_to_dict(r) for r in reversed(list(monthly))],
        "topProducts": [row_to_dict(r) for r in top_products],
        "topClients": [row_to_dict(r) for r in top_clients],
        "margins": margins,
        "lowStock": [row_to_dict(r) for r in low],
    })


@bp.route("/low-stock/alert", methods=["POST"])
@require_admin
def trigger_low_stock_alert():
    """Send low-stock alert email using SMTP config from request body (IndexedDB)."""
    data = _json_body()
    smtp = data.get("smtp") or {}
    to = (data.get("to") or smtp.get("fromEmail") or "").strip()
    if not to:
        return jsonify({"ok": False, "error": "Recipient email required."}), 400

    with get_connection() as conn:
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        rows = conn.execute(
            """
            SELECT name, stock, COALESCE(low_stock_limit, ?) as limit_val
            FROM products WHERE stock <= COALESCE(low_stock_limit, ?)
            ORDER BY stock ASC
            """,
            (default_limit, default_limit),
        ).fetchall()

    if not rows:
        return jsonify({"ok": True, "message": "No low-stock items. No email sent.", "count": 0})

    lines = [f"- {r['name']}: stock {r['stock']} (limit {r['limit_val']})" for r in rows]
    body = "Low stock alert from OrbitBills\n\n" + "\n".join(lines) + f"\n\nTotal items: {len(rows)}"

    # reuse email send logic
    host = (smtp.get("host") or "").strip()
    if not host:
        return jsonify({"ok": False, "error": "SMTP host required in settings."}), 400
    port = int(smtp.get("port") or 587)
    user = (smtp.get("user") or "").strip()
    password = smtp.get("password") or ""
    use_tls = smtp.get("useTls", True)
    from_email = (smtp.get("fromEmail") or user or "").strip()
    from_name = (smtp.get("fromName") or "OrbitBills").strip()
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Low stock alert — {len(rows)} item(s)"
        msg["From"] = f"{from_name} <{from_email}>"
        msg["To"] = to
        msg.attach(MIMEText(body, "plain", "utf-8"))
        with smtplib.SMTP(host, port, timeout=20) as server:
            if use_tls:
                server.starttls()
            if user and password:
                server.login(user, password)
            server.sendmail(from_email, [to], msg.as_string())
    except Exception as e:
        return jsonify({"ok": False, "error": f"Email failed: {str(e)}"}), 400
    return jsonify({"ok": True, "count": len(rows)})


# ---------------------------------------------------------------------------
# CLIENT STATEMENTS
# ---------------------------------------------------------------------------

@bp.route("/clients/<int:client_id>/statement", methods=["GET"])
@require_billing_or_admin
def client_statement(client_id):
    date_from = request.args.get("from", "")
    date_to = request.args.get("to", "")
    with get_connection() as conn:
        client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not client:
            return jsonify({"ok": False, "error": "Client not found."}), 404
        q = "SELECT * FROM invoices WHERE client_id = ?"
        params = [client_id]
        if date_from:
            q += " AND created_at >= ?"
            params.append(date_from)
        if date_to:
            q += " AND created_at <= ?"
            params.append(date_to + " 23:59:59")
        q += " ORDER BY created_at ASC"
        invoices = conn.execute(q, params).fetchall()
        credits = conn.execute(
            "SELECT * FROM credit_transactions WHERE client_id = ? ORDER BY created_at ASC",
            (client_id,),
        ).fetchall()

    inv_list = [row_to_dict(r) for r in invoices]
    total_invoiced = sum(float(i.get("total") or 0) for i in inv_list)
    total_paid = sum(float(i.get("total") or 0) for i in inv_list if i.get("status") == "paid")
    total_unpaid = sum(float(i.get("total") or 0) for i in inv_list if i.get("status") == "unpaid")

    return jsonify({
        "ok": True,
        "client": row_to_dict(client),
        "invoices": inv_list,
        "creditTransactions": [row_to_dict(r) for r in credits],
        "summary": {
            "totalInvoiced": total_invoiced,
            "totalBilled": total_invoiced,
            "totalPaid": total_paid,
            "totalUnpaid": total_unpaid,
            "outstanding": total_unpaid,
            "creditBalance": float(client["credit_balance"] or 0),
        },
        "credits": [row_to_dict(r) for r in credits],
        "from": date_from,
        "to": date_to,
    })


# ---------------------------------------------------------------------------
# WHATSAPP (wa.me link generator — no paid API required)
# ---------------------------------------------------------------------------

@bp.route("/whatsapp/invoice-link", methods=["POST"])
@require_admin
def whatsapp_invoice_link():
    """
    Build a wa.me deep link with pre-filled invoice message.
    Optional: create share token so message includes public URL.
    Body: { invoiceId, phone, baseUrl? }
    """
    data = _json_body()
    invoice_id = data.get("invoiceId")
    phone = "".join(c for c in str(data.get("phone") or "") if c.isdigit() or c == "+")
    base_url = (data.get("baseUrl") or request.host_url.rstrip("/")).rstrip("/")
    if not invoice_id:
        return jsonify({"ok": False, "error": "invoiceId required."}), 400

    with get_connection() as conn:
        inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        existing = conn.execute(
            "SELECT token FROM invoice_share_tokens WHERE invoice_id = ?", (invoice_id,)
        ).fetchone()
        if existing:
            token = existing["token"]
        else:
            token = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO invoice_share_tokens (token, invoice_id) VALUES (?, ?)",
                (token, invoice_id),
            )
        brand = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'brand_name'"
        ).fetchone()
        brand_name = brand["value"] if brand else "OrbitBills"

    share_url = f"{base_url}/share/invoice/{token}"
    text = (
        f"Hello {inv['client_name'] or ''},\n\n"
        f"Your invoice *{inv['invoice_number']}* from {brand_name}.\n"
        f"Amount: {float(inv['total'] or 0):.2f}\n"
        f"Status: {inv['status']}\n\n"
        f"View invoice: {share_url}\n\nThank you!"
    )
    from urllib.parse import quote
    wa_url = f"https://wa.me/{phone.lstrip('+')}?text={quote(text)}" if phone else f"https://wa.me/?text={quote(text)}"
    return jsonify({
        "ok": True,
        "waUrl": wa_url,
        "shareUrl": share_url,
        "token": token,
        "message": text,
    })


@bp.route("/inventory/movements", methods=["GET"])
@require_admin
def list_movements():
    limit = min(int(request.args.get("limit", 100)), 500)
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM inventory_movements ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return jsonify({"ok": True, "movements": [row_to_dict(r) for r in rows]})



# ---------------------------------------------------------------------------
# PAYMENTS (partial + full)
# ---------------------------------------------------------------------------

def _refresh_invoice_payment_status(conn, invoice_id):
    inv = conn.execute("SELECT total, amount_paid FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not inv:
        return
    paid = float(inv["amount_paid"] or 0)
    total = float(inv["total"] or 0)
    if paid <= 0:
        status = "unpaid"
    elif paid + 0.001 >= total:
        status = "paid"
        paid = total
    else:
        status = "partial"
    conn.execute("UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?", (paid, status, invoice_id))


@bp.route("/invoices/<int:invoice_id>/payments", methods=["GET"])
@require_admin
def list_payments(invoice_id):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at DESC", (invoice_id,)
        ).fetchall()
        inv = conn.execute("SELECT id, total, amount_paid, status FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return jsonify({
        "ok": True,
        "payments": [row_to_dict(r) for r in rows],
        "invoice": row_to_dict(inv) if inv else None,
    })


@bp.route("/invoices/<int:invoice_id>/payments", methods=["POST"])
@require_admin
def add_payment(invoice_id):
    data = _json_body()
    try:
        amount = float(data.get("amount"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Amount must be a number."}), 400
    if amount <= 0:
        return jsonify({"ok": False, "error": "Amount must be positive."}), 400
    method = (data.get("method") or "cash").strip()
    reference = (data.get("reference") or "").strip()
    notes = (data.get("notes") or "").strip()
    with get_connection() as conn:
        inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        remaining = max(0.0, float(inv["total"] or 0) - float(inv["amount_paid"] or 0))
        if amount > remaining + 0.01:
            return jsonify({"ok": False, "error": f"Amount exceeds remaining balance ({remaining:.2f})."}), 400
        conn.execute(
            "INSERT INTO payments (invoice_id, amount, method, reference, notes) VALUES (?,?,?,?,?)",
            (invoice_id, amount, method, reference, notes),
        )
        new_paid = float(inv["amount_paid"] or 0) + amount
        conn.execute("UPDATE invoices SET amount_paid = ? WHERE id = ?", (new_paid, invoice_id))
        _refresh_invoice_payment_status(conn, invoice_id)
        inv2 = conn.execute("SELECT total, amount_paid, status FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return jsonify({"ok": True, "amountPaid": inv2["amount_paid"], "status": inv2["status"]})


@bp.route("/payments/<int:payment_id>", methods=["DELETE"])
@require_admin
def delete_payment(payment_id):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Payment not found."}), 404
        invoice_id = row["invoice_id"]
        conn.execute("DELETE FROM payments WHERE id = ?", (payment_id,))
        inv = conn.execute("SELECT amount_paid FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        new_paid = max(0.0, float(inv["amount_paid"] or 0) - float(row["amount"]))
        conn.execute("UPDATE invoices SET amount_paid = ? WHERE id = ?", (new_paid, invoice_id))
        _refresh_invoice_payment_status(conn, invoice_id)
    return jsonify({"ok": True})


@bp.route("/invoices/<int:invoice_id>/payment-link", methods=["GET"])
@require_admin
def invoice_payment_link(invoice_id):
    """Build UPI deep link + share URL for online payment."""
    with get_connection() as conn:
        inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
        existing = conn.execute(
            "SELECT token FROM invoice_share_tokens WHERE invoice_id = ?", (invoice_id,)
        ).fetchone()
        if existing:
            token = existing["token"]
        else:
            token = uuid.uuid4().hex
            conn.execute("INSERT INTO invoice_share_tokens (token, invoice_id) VALUES (?, ?)", (token, invoice_id))

    remaining = max(0.0, float(inv["total"] or 0) - float(inv["amount_paid"] or 0))
    upi_id = branding.get("upi_id") or ""
    upi_name = branding.get("upi_name") or branding.get("brand_name") or "OrbitBills"
    from urllib.parse import quote
    upi_link = ""
    if upi_id and remaining > 0:
        upi_link = (
            f"upi://pay?pa={quote(upi_id)}&pn={quote(upi_name)}"
            f"&am={remaining:.2f}&cu=INR&tn={quote('Invoice '+str(inv['invoice_number']))}"
        )
    return jsonify({
        "ok": True,
        "upiId": upi_id,
        "upiLink": upi_link,
        "amountDue": remaining,
        "sharePath": f"/share/invoice/{token}",
        "note": branding.get("payment_link_note") or "",
    })


# ---------------------------------------------------------------------------
# QUOTATIONS
# ---------------------------------------------------------------------------

@bp.route("/quotations", methods=["GET"])
@require_admin
def list_quotations():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM quotations ORDER BY created_at DESC").fetchall()
        out = []
        for r in rows:
            q = row_to_dict(r)
            items = conn.execute("SELECT * FROM quotation_items WHERE quotation_id = ?", (r["id"],)).fetchall()
            q["items"] = [row_to_dict(i) for i in items]
            out.append(q)
    return jsonify({"ok": True, "quotations": out})


@bp.route("/quotations", methods=["POST"])
@require_admin
def create_quotation():
    data = _json_body()
    quote_number = (data.get("quoteNumber") or f"QT-{int(time.time())}").strip()
    items = data.get("items") or []
    if not items:
        return jsonify({"ok": False, "error": "Add at least one line item."}), 400
    discount = float(data.get("discount", 0) or 0)
    subtotal, tax_amount, total = _calc_invoice_totals(items, discount, 0)
    client_id = data.get("clientId")
    client_name = (data.get("clientName") or "").strip()
    with get_connection() as conn:
        if client_id and not client_name:
            c = conn.execute("SELECT name FROM clients WHERE id = ?", (client_id,)).fetchone()
            client_name = c["name"] if c else ""
        cur = conn.execute(
            """
            INSERT INTO quotations (quote_number, client_id, client_name, subtotal, discount,
                tax_amount, total, status, notes, valid_until)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (quote_number, client_id, client_name, subtotal, discount, tax_amount, total,
             data.get("status", "draft"), data.get("notes", ""), data.get("validUntil", "")),
        )
        qid = cur.lastrowid
        for it in items:
            conn.execute(
                "INSERT INTO quotation_items (quotation_id, product_id, name, qty, price, tax_percent) VALUES (?,?,?,?,?,?)",
                (qid, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                 it.get("price", 0), it.get("taxPercent", 0)),
            )
    return jsonify({"ok": True, "id": qid, "total": total})


@bp.route("/quotations/<int:qid>", methods=["GET"])
@require_admin
def get_quotation(qid):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM quotations WHERE id = ?", (qid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Quotation not found."}), 404
        items = conn.execute("SELECT * FROM quotation_items WHERE quotation_id = ?", (qid,)).fetchall()
    q = row_to_dict(row)
    q["items"] = [row_to_dict(i) for i in items]
    return jsonify({"ok": True, "quotation": q})


@bp.route("/quotations/<int:qid>", methods=["DELETE"])
@require_admin
def delete_quotation(qid):
    with get_connection() as conn:
        conn.execute("DELETE FROM quotation_items WHERE quotation_id = ?", (qid,))
        conn.execute("DELETE FROM quotations WHERE id = ?", (qid,))
    return jsonify({"ok": True})


@bp.route("/quotations/<int:qid>/convert", methods=["POST"])
@require_admin
def convert_quotation_to_invoice(qid):
    """Create an invoice from a quotation and mark quote as converted."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM quotations WHERE id = ?", (qid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Quotation not found."}), 404
        if row["status"] == "converted":
            return jsonify({"ok": False, "error": "Already converted."}), 400
        items = conn.execute("SELECT * FROM quotation_items WHERE quotation_id = ?", (qid,)).fetchall()
        item_payload = [
            {"productId": i["product_id"], "name": i["name"], "qty": i["qty"],
             "price": i["price"], "taxPercent": i["tax_percent"]}
            for i in items
        ]
        discount = float(row["discount"] or 0)
        subtotal, tax_amount, total = _calc_invoice_totals(item_payload, discount, 0)
        inv_number = f"INV-{int(time.time())}"
        s = conn.execute("SELECT value FROM branding_settings WHERE key = 'active_layout_id'").fetchone()
        layout_id = int(s["value"]) if s and s["value"] else None
        cur = conn.execute(
            """
            INSERT INTO invoices (invoice_number, client_id, client_name, subtotal, discount,
                tax_amount, total, credit_applied, status, notes, layout_id, amount_paid)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (inv_number, row["client_id"], row["client_name"], subtotal, discount, tax_amount, total,
             0, "unpaid", row["notes"] or "", layout_id, 0),
        )
        invoice_id = cur.lastrowid
        for it in item_payload:
            conn.execute(
                "INSERT INTO invoice_items (invoice_id, product_id, name, qty, price, tax_percent) VALUES (?,?,?,?,?,?)",
                (invoice_id, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                 it.get("price", 0), it.get("taxPercent", 0)),
            )
        _deduct_invoice_stock(conn, item_payload, invoice_id)
        conn.execute("UPDATE quotations SET status = 'converted' WHERE id = ?", (qid,))
    return jsonify({"ok": True, "invoiceId": invoice_id, "invoiceNumber": inv_number})


# ---------------------------------------------------------------------------
# PRODUCT VARIANTS
# ---------------------------------------------------------------------------

@bp.route("/products/<int:product_id>/variants", methods=["GET"])
@require_admin
def list_variants(product_id):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM product_variants WHERE product_id = ? ORDER BY id", (product_id,)
        ).fetchall()
    return jsonify({"ok": True, "variants": [row_to_dict(r) for r in rows]})


@bp.route("/products/<int:product_id>/variants", methods=["POST"])
@require_admin
def create_variant(product_id):
    data = _json_body()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Variant name required."}), 400
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
            return jsonify({"ok": False, "error": "Product not found."}), 404
        cur = conn.execute(
            """
            INSERT INTO product_variants (product_id, name, sku, barcode, price, cost_price, stock)
            VALUES (?,?,?,?,?,?,?)
            """,
            (product_id, name, data.get("sku", ""), data.get("barcode", ""),
             data.get("price"), data.get("costPrice"), int(data.get("stock", 0) or 0)),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/variants/<int:vid>", methods=["PUT"])
@require_admin
def update_variant(vid):
    data = _json_body()
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM product_variants WHERE id = ?", (vid,)).fetchone()
        if not existing:
            return jsonify({"ok": False, "error": "Variant not found."}), 404
        conn.execute(
            """
            UPDATE product_variants SET name=?, sku=?, barcode=?, price=?, cost_price=?, stock=? WHERE id=?
            """,
            (
                data.get("name", existing["name"]),
                data.get("sku", existing["sku"]),
                data.get("barcode", existing["barcode"]),
                data.get("price", existing["price"]),
                data.get("costPrice", existing["cost_price"]),
                int(data.get("stock", existing["stock"]) or 0),
                vid,
            ),
        )
    return jsonify({"ok": True})


@bp.route("/variants/<int:vid>", methods=["DELETE"])
@require_admin
def delete_variant(vid):
    with get_connection() as conn:
        conn.execute("DELETE FROM product_variants WHERE id = ?", (vid,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# BATCHES / EXPIRY
# ---------------------------------------------------------------------------

@bp.route("/products/<int:product_id>/batches", methods=["GET"])
@require_admin
def list_batches(product_id):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM product_batches WHERE product_id = ? ORDER BY expiry_date ASC", (product_id,)
        ).fetchall()
    return jsonify({"ok": True, "batches": [row_to_dict(r) for r in rows]})


@bp.route("/products/<int:product_id>/batches", methods=["POST"])
@require_admin
def create_batch(product_id):
    data = _json_body()
    batch_number = (data.get("batchNumber") or "").strip()
    if not batch_number:
        return jsonify({"ok": False, "error": "Batch number required."}), 400
    qty = int(data.get("qty", 0) or 0)
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
            return jsonify({"ok": False, "error": "Product not found."}), 404
        cur = conn.execute(
            """
            INSERT INTO product_batches (product_id, variant_id, batch_number, qty, expiry_date, manufactured_date, notes)
            VALUES (?,?,?,?,?,?,?)
            """,
            (product_id, data.get("variantId"), batch_number, qty,
             data.get("expiryDate", ""), data.get("manufacturedDate", ""), data.get("notes", "")),
        )
        if qty:
            _adjust_stock(conn, product_id, qty, reason=f"Batch {batch_number} in", ref_type="batch", ref_id=cur.lastrowid)
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/batches/<int:bid>", methods=["DELETE"])
@require_admin
def delete_batch(bid):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM product_batches WHERE id = ?", (bid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Batch not found."}), 404
        if row["qty"]:
            _adjust_stock(conn, row["product_id"], -int(row["qty"]),
                          reason=f"Delete batch {row['batch_number']}", ref_type="batch", ref_id=bid)
        conn.execute("DELETE FROM product_batches WHERE id = ?", (bid,))
    return jsonify({"ok": True})


@bp.route("/batches/expiring", methods=["GET"])
@require_admin
def expiring_batches():
    days = int(request.args.get("days", 30))
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT b.*, p.name as product_name FROM product_batches b
            JOIN products p ON p.id = b.product_id
            WHERE b.expiry_date IS NOT NULL AND b.expiry_date != ''
              AND date(b.expiry_date) <= date('now', ?)
            ORDER BY b.expiry_date ASC
            """,
            (f"+{days} days",),
        ).fetchall()
    return jsonify({"ok": True, "batches": [row_to_dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# SAVED QR / BARCODE DESIGNS
# ---------------------------------------------------------------------------

@bp.route("/codes", methods=["GET"])
@require_admin
def list_codes():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM saved_codes ORDER BY created_at DESC").fetchall()
    return jsonify({"ok": True, "codes": [row_to_dict(r) for r in rows]})


@bp.route("/codes", methods=["POST"])
@require_admin
def save_code():
    data = _json_body()
    name = (data.get("name") or "").strip()
    payload = (data.get("payload") or "").strip()
    if not name or not payload:
        return jsonify({"ok": False, "error": "Name and payload required."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO saved_codes (name, code_type, payload, design_json) VALUES (?,?,?,?)",
            (name, data.get("codeType", "qr"), payload, json.dumps(data.get("design") or {})),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/codes/<int:cid>", methods=["DELETE"])
@require_admin
def delete_code(cid):
    with get_connection() as conn:
        conn.execute("DELETE FROM saved_codes WHERE id = ?", (cid,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# INVENTORY MOVEMENTS (list already exists — add manual adjust)
# ---------------------------------------------------------------------------

@bp.route("/inventory/adjust", methods=["POST"])
@require_admin
def inventory_adjust():
    data = _json_body()
    product_id = data.get("productId")
    try:
        delta = int(data.get("delta"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "delta must be an integer."}), 400
    reason = (data.get("reason") or "Manual adjust").strip()
    if not product_id:
        return jsonify({"ok": False, "error": "productId required."}), 400
    with get_connection() as conn:
        _adjust_stock(conn, product_id, delta, reason=reason, ref_type="manual", ref_id=None)
        row = conn.execute("SELECT stock FROM products WHERE id = ?", (product_id,)).fetchone()
    return jsonify({"ok": True, "stock": row["stock"] if row else None})


# Enhance public share page with payment QR note is already HTML — leave as is



# ===========================================================================
# CASH SHIFTS / DRAWER
# ===========================================================================

@bp.route("/shifts/current", methods=["GET"])
@require_billing_or_admin
def current_shift():
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM cash_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return jsonify({"ok": True, "shift": row_to_dict(row)})


@bp.route("/shifts", methods=["GET"])
@require_admin
def list_shifts():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM cash_shifts ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify({"ok": True, "shifts": [row_to_dict(r) for r in rows]})


@bp.route("/shifts/open", methods=["POST"])
@require_billing_or_admin
def open_shift():
    data = _json_body()
    opening = float(data.get("openingFloat", 0) or 0)
    with get_connection() as conn:
        existing = conn.execute("SELECT id FROM cash_shifts WHERE status = 'open'").fetchone()
        if existing:
            return jsonify({"ok": False, "error": "A shift is already open. Close it first."}), 400
        cur = conn.execute(
            """
            INSERT INTO cash_shifts (user_email, user_name, opening_float, status)
            VALUES (?,?,?, 'open')
            """,
            (session.get("email", ""), data.get("userName", ""), opening),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/shifts/<int:sid>/close", methods=["POST"])
@require_billing_or_admin
def close_shift(sid):
    data = _json_body()
    closing_cash = float(data.get("closingCash", 0) or 0)
    notes = (data.get("notes") or "").strip()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM cash_shifts WHERE id = ?", (sid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Shift not found."}), 404
        if row["status"] != "open":
            return jsonify({"ok": False, "error": "Shift already closed."}), 400
        # sum paid invoices during shift window as rough cash sales
        opened = row["opened_at"]
        paid = conn.execute(
            """
            SELECT COALESCE(SUM(amount_paid),0) s FROM invoices
            WHERE created_at >= ? AND status IN ('paid','partial')
            """,
            (opened,),
        ).fetchone()["s"]
        cash_from_payments = conn.execute(
            """
            SELECT COALESCE(SUM(amount),0) s FROM payments
            WHERE created_at >= ? AND lower(method) = 'cash'
            """,
            (opened,),
        ).fetchone()["s"]
        upi_s = conn.execute(
            "SELECT COALESCE(SUM(amount),0) s FROM payments WHERE created_at >= ? AND lower(method)='upi'",
            (opened,),
        ).fetchone()["s"]
        card_s = conn.execute(
            "SELECT COALESCE(SUM(amount),0) s FROM payments WHERE created_at >= ? AND lower(method)='card'",
            (opened,),
        ).fetchone()["s"]
        expected = float(row["opening_float"] or 0) + float(cash_from_payments or 0)
        variance = closing_cash - expected
        conn.execute(
            """
            UPDATE cash_shifts SET closed_at = CURRENT_TIMESTAMP, closing_cash = ?, expected_cash = ?,
                cash_sales = ?, card_sales = ?, upi_sales = ?, other_sales = ?, variance = ?, notes = ?, status = 'closed'
            WHERE id = ?
            """,
            (closing_cash, expected, cash_from_payments, card_s, upi_s,
             max(0, float(paid or 0) - float(cash_from_payments or 0) - float(upi_s or 0) - float(card_s or 0)),
             variance, notes, sid),
        )
    return jsonify({"ok": True, "expected": expected, "variance": variance})


# ===========================================================================
# HELD BILLS (park / resume cart)
# ===========================================================================

@bp.route("/held-bills", methods=["GET"])
@require_billing_or_admin
def list_held_bills():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM held_bills ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = row_to_dict(r)
        try:
            d["cart"] = json.loads(d.pop("cart_json") or "[]")
        except Exception:
            d["cart"] = []
        out.append(d)
    return jsonify({"ok": True, "heldBills": out})


@bp.route("/held-bills", methods=["POST"])
@require_billing_or_admin
def hold_bill():
    data = _json_body()
    cart = data.get("cart") or []
    if not cart:
        return jsonify({"ok": False, "error": "Cart is empty."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO held_bills (label, client_id, client_name, cart_json, discount, credit_applied, notes, created_by)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (
                (data.get("label") or f"Hold {int(time.time())}")[:80],
                data.get("clientId"),
                data.get("clientName", ""),
                json.dumps(cart),
                float(data.get("discount", 0) or 0),
                float(data.get("creditApplied", 0) or 0),
                data.get("notes", ""),
                session.get("email", ""),
            ),
        )
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/held-bills/<int:hid>", methods=["DELETE"])
@require_billing_or_admin
def delete_held_bill(hid):
    with get_connection() as conn:
        conn.execute("DELETE FROM held_bills WHERE id = ?", (hid,))
    return jsonify({"ok": True})


@bp.route("/held-bills/<int:hid>", methods=["GET"])
@require_billing_or_admin
def get_held_bill(hid):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM held_bills WHERE id = ?", (hid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Not found."}), 404
    d = row_to_dict(row)
    try:
        d["cart"] = json.loads(d.pop("cart_json") or "[]")
    except Exception:
        d["cart"] = []
    return jsonify({"ok": True, "heldBill": d})


# ===========================================================================
# PRICE LISTS
# ===========================================================================

@bp.route("/price-lists", methods=["GET"])
@require_billing_or_admin
def list_price_lists():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM price_lists ORDER BY name").fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            items = conn.execute(
                "SELECT * FROM price_list_items WHERE price_list_id = ?", (r["id"],)
            ).fetchall()
            d["items"] = [row_to_dict(i) for i in items]
            out.append(d)
    return jsonify({"ok": True, "priceLists": out})


@bp.route("/price-lists", methods=["POST"])
@require_admin
def create_price_list():
    data = _json_body()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Name required."}), 400
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO price_lists (name, notes) VALUES (?,?)",
            (name, data.get("notes", "")),
        )
        plid = cur.lastrowid
        for it in data.get("items") or []:
            if it.get("productId") is None:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO price_list_items (price_list_id, product_id, price) VALUES (?,?,?)",
                (plid, it["productId"], float(it.get("price", 0))),
            )
    return jsonify({"ok": True, "id": plid})


@bp.route("/price-lists/<int:plid>", methods=["PUT"])
@require_admin
def update_price_list(plid):
    data = _json_body()
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM price_lists WHERE id = ?", (plid,)).fetchone():
            return jsonify({"ok": False, "error": "Not found."}), 404
        if data.get("name") is not None:
            conn.execute(
                "UPDATE price_lists SET name = ?, notes = ? WHERE id = ?",
                (data.get("name"), data.get("notes", ""), plid),
            )
        if "items" in data:
            conn.execute("DELETE FROM price_list_items WHERE price_list_id = ?", (plid,))
            for it in data["items"] or []:
                conn.execute(
                    "INSERT INTO price_list_items (price_list_id, product_id, price) VALUES (?,?,?)",
                    (plid, it["productId"], float(it.get("price", 0))),
                )
    return jsonify({"ok": True})


@bp.route("/price-lists/<int:plid>", methods=["DELETE"])
@require_admin
def delete_price_list(plid):
    with get_connection() as conn:
        conn.execute("DELETE FROM price_list_items WHERE price_list_id = ?", (plid,))
        conn.execute("DELETE FROM price_lists WHERE id = ?", (plid,))
        conn.execute("UPDATE clients SET price_list_id = NULL WHERE price_list_id = ?", (plid,))
    return jsonify({"ok": True})


@bp.route("/clients/<int:client_id>/price-list", methods=["POST"])
@require_admin
def assign_client_price_list(client_id):
    data = _json_body()
    plid = data.get("priceListId")  # null to clear
    with get_connection() as conn:
        conn.execute("UPDATE clients SET price_list_id = ? WHERE id = ?", (plid, client_id))
    return jsonify({"ok": True})


@bp.route("/clients/<int:client_id>/prices", methods=["GET"])
@require_billing_or_admin
def client_effective_prices(client_id):
    """Map product_id -> special price for this client's price list."""
    with get_connection() as conn:
        c = conn.execute("SELECT price_list_id FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not c or not c["price_list_id"]:
            return jsonify({"ok": True, "prices": {}})
        rows = conn.execute(
            "SELECT product_id, price FROM price_list_items WHERE price_list_id = ?",
            (c["price_list_id"],),
        ).fetchall()
    return jsonify({"ok": True, "prices": {str(r["product_id"]): r["price"] for r in rows}, "priceListId": c["price_list_id"]})


# ===========================================================================
# RETURNS / CREDIT NOTES (from billing or admin)
# ===========================================================================

@bp.route("/returns", methods=["GET"])
@require_billing_or_admin
def list_returns():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM returns ORDER BY created_at DESC LIMIT 100").fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            items = conn.execute("SELECT * FROM return_items WHERE return_id = ?", (r["id"],)).fetchall()
            d["items"] = [row_to_dict(i) for i in items]
            out.append(d)
    return jsonify({"ok": True, "returns": out})


@bp.route("/returns", methods=["POST"])
@require_billing_or_admin
def create_return():
    """
    Body: {
      invoiceId?, clientId?, clientName?,
      items: [{productId, name, qty, price}],
      restock: true/false,
      creditToClient: true/false,
      notes
    }
    """
    data = _json_body()
    items = data.get("items") or []
    if not items:
        return jsonify({"ok": False, "error": "Add return line items."}), 400
    restock = 1 if data.get("restock", True) else 0
    credit_to_client = 1 if data.get("creditToClient") else 0
    total = sum(float(it.get("qty", 1)) * float(it.get("price", 0)) for it in items)
    ret_number = f"RTN-{int(time.time())}"
    client_id = data.get("clientId")
    client_name = (data.get("clientName") or "").strip()
    invoice_id = data.get("invoiceId")
    with get_connection() as conn:
        if client_id and not client_name:
            c = conn.execute("SELECT name FROM clients WHERE id = ?", (client_id,)).fetchone()
            client_name = c["name"] if c else ""
        cur = conn.execute(
            """
            INSERT INTO returns (return_number, invoice_id, client_id, client_name, total, restock, credit_to_client, notes)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (ret_number, invoice_id, client_id, client_name, total, restock, credit_to_client, data.get("notes", "")),
        )
        rid = cur.lastrowid
        for it in items:
            conn.execute(
                "INSERT INTO return_items (return_id, product_id, name, qty, price) VALUES (?,?,?,?,?)",
                (rid, it.get("productId"), it.get("name", ""), it.get("qty", 1), it.get("price", 0)),
            )
            if restock and it.get("productId"):
                _adjust_stock(
                    conn, it["productId"], int(float(it.get("qty", 1))),
                    reason=f"Return {ret_number}", ref_type="return", ref_id=rid,
                )
        if credit_to_client and client_id and total > 0:
            c = conn.execute("SELECT credit_balance FROM clients WHERE id = ?", (client_id,)).fetchone()
            if c:
                new_bal = float(c["credit_balance"] or 0) + total
                conn.execute("UPDATE clients SET credit_balance = ? WHERE id = ?", (new_bal, client_id))
                conn.execute(
                    "INSERT INTO credit_transactions (client_id, amount, reason, balance_after) VALUES (?,?,?,?)",
                    (client_id, total, f"Credit from return {ret_number}", new_bal),
                )
    return jsonify({"ok": True, "id": rid, "returnNumber": ret_number, "total": total})


# ===========================================================================
# REORDER SUGGESTIONS
# ===========================================================================

@bp.route("/reorder-suggestions", methods=["GET"])
@require_billing_or_admin
def reorder_suggestions():
    """Suggest qty based on last 30 days sales velocity and low-stock limits."""
    days = int(request.args.get("days", 30))
    with get_connection() as conn:
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        products = conn.execute("SELECT * FROM products").fetchall()
        # sales qty per product in window
        sales = conn.execute(
            """
            SELECT ii.product_id, SUM(ii.qty) qty
            FROM invoice_items ii
            JOIN invoices inv ON inv.id = ii.invoice_id
            WHERE ii.product_id IS NOT NULL
              AND date(inv.created_at) >= date('now', ?)
            GROUP BY ii.product_id
            """,
            (f"-{days} days",),
        ).fetchall()
        sold = {r["product_id"]: float(r["qty"] or 0) for r in sales}
        suggestions = []
        for p in products:
            pid = p["id"]
            stock = int(p["stock"] or 0)
            limit = p["low_stock_limit"] if p["low_stock_limit"] is not None else default_limit
            velocity = sold.get(pid, 0) / max(days, 1)  # units per day
            days_cover = (stock / velocity) if velocity > 0 else 999
            # suggest if low stock OR less than 7 days cover
            if stock <= limit or days_cover < 7:
                target_days = 14
                suggest_qty = max(0, int(velocity * target_days - stock + 0.99))
                if suggest_qty < 1 and stock <= limit:
                    suggest_qty = max(limit - stock, 1)
                if suggest_qty > 0:
                    suggestions.append({
                        "productId": pid,
                        "name": p["name"],
                        "sku": p["sku"],
                        "stock": stock,
                        "lowStockLimit": limit,
                        "soldLastPeriod": sold.get(pid, 0),
                        "dailyVelocity": round(velocity, 2),
                        "daysCover": round(days_cover, 1) if days_cover < 999 else None,
                        "suggestQty": suggest_qty,
                        "costPrice": p["cost_price"] if "cost_price" in p.keys() else 0,
                    })
        suggestions.sort(key=lambda x: x["suggestQty"], reverse=True)
    return jsonify({"ok": True, "days": days, "suggestions": suggestions})


# ===========================================================================
# INVOICE RENDER: HTML / PDF / PNG helpers
# ===========================================================================

def _invoice_html_document(inv, items, branding, layout_elements=None):
    """Build a full HTML invoice document string for print/export."""
    brand = branding.get("brand_name") or "TechSerenia"
    tagline = branding.get("brand_tagline") or "OrbitBills"
    accent = branding.get("accent_color") or "#0b3d91"
    footer = branding.get("footer_note") or "Thank you for your business!"
    address = branding.get("brand_address") or ""
    phone = branding.get("brand_phone") or ""
    email = branding.get("brand_email") or ""
    currency = branding.get("currency_symbol") or "₹"
    logo = branding.get("custom_brand_logo") or ""

    rows = "".join(
        "<tr><td>%s</td><td style='text-align:center'>%s</td>"
        "<td style='text-align:right'>%.2f</td><td style='text-align:right'>%.2f</td></tr>"
        % (
            _esc(i.get("name", "")),
            i.get("qty", 1),
            float(i.get("price", 0)),
            float(i.get("qty", 1)) * float(i.get("price", 0)),
        )
        for i in items
    )
    logo_html = f'<img src="{_esc(logo)}" style="max-height:64px;max-width:120px;" alt="logo">' if logo else ""
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice {_esc(inv.get('invoice_number',''))}</title>
<style>
body{{font-family:system-ui,sans-serif;color:#101a2b;max-width:720px;margin:24px auto;padding:0 16px}}
h1{{color:{accent};font-size:22px;margin:0}}
.meta{{color:#5b6b82;font-size:13px;margin:8px 0 20px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}
th,td{{padding:8px;border-bottom:1px solid #dfe7f5;text-align:left}}
th{{font-size:11px;color:#5b6b82;text-transform:uppercase}}
.total{{font-size:20px;font-weight:700;color:{accent};text-align:right;margin-top:16px}}
.wm{{font-size:10px;color:{accent};font-weight:700;text-align:center;margin-top:28px}}
.header{{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}}
</style></head><body>
<div class="header">
  <div>{logo_html}<h1>{_esc(brand)}</h1>
  <div style="font-size:13px;color:#5b6b82">{_esc(tagline)}</div>
  <div style="font-size:12px;color:#5b6b82;white-space:pre-wrap;margin-top:6px">{_esc(address)}</div>
  <div style="font-size:12px;color:#5b6b82">{_esc(' · '.join(x for x in [phone,email] if x))}</div>
  </div>
  <div style="text-align:right;font-size:13px">
    <strong>Invoice {_esc(inv.get('invoice_number',''))}</strong><br>
    Status: {_esc(inv.get('status',''))}<br>
    Client: {_esc(inv.get('client_name',''))}
  </div>
</div>
<table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead>
<tbody>{rows}</tbody></table>
<div style="text-align:right;margin-top:12px;font-size:13.5px">
  <div>Subtotal: {currency}{float(inv.get('subtotal') or 0):.2f}</div>
  <div>Discount: -{currency}{float(inv.get('discount') or 0):.2f}</div>
  <div>Tax: {currency}{float(inv.get('tax_amount') or 0):.2f}</div>
  {f"<div>Credit: -{currency}{float(inv.get('credit_applied') or 0):.2f}</div>" if float(inv.get('credit_applied') or 0) else ""}
</div>
<div class="total">Total: {currency}{float(inv.get('total') or 0):.2f}</div>
<p style="color:#5b6b82;font-size:12px;margin-top:20px">{_esc(footer)}</p>
<p class="wm">OrbitBills Powered By TechSerenia</p>
</body></html>"""


@bp.route("/invoices/<int:invoice_id>/export/html", methods=["GET"])
@require_billing_or_admin
def export_invoice_html(invoice_id):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        items = [row_to_dict(i) for i in conn.execute(
            "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)
        ).fetchall()]
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
    inv = row_to_dict(row)
    html = _invoice_html_document(inv, items, branding)
    return Response(html, mimetype="text/html")


@bp.route("/invoices/<int:invoice_id>/export/pdf", methods=["GET"])
@require_billing_or_admin
def export_invoice_pdf(invoice_id):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.lib.units import mm
    except ImportError:
        return jsonify({"ok": False, "error": "PDF library not installed on server."}), 500

    with get_connection() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        items = conn.execute(
            "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)
        ).fetchall()
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}

    inv = row_to_dict(row)
    brand = branding.get("brand_name") or "TechSerenia"
    currency = branding.get("currency_symbol") or "Rs."
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    y = h - 40
    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, y, brand)
    y -= 18
    c.setFont("Helvetica", 10)
    c.drawString(40, y, branding.get("brand_tagline") or "OrbitBills")
    y -= 16
    c.drawString(40, y, f"Invoice {inv.get('invoice_number','')}")
    y -= 14
    c.drawString(40, y, f"Client: {inv.get('client_name','')}  |  Status: {inv.get('status','')}")
    y -= 24
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "Item")
    c.drawString(300, y, "Qty")
    c.drawString(360, y, "Price")
    c.drawString(440, y, "Amount")
    y -= 12
    c.line(40, y, w - 40, y)
    y -= 14
    c.setFont("Helvetica", 10)
    for it in items:
        if y < 80:
            c.showPage()
            y = h - 40
        name = (it["name"] or "")[:40]
        qty = float(it["qty"] or 1)
        price = float(it["price"] or 0)
        c.drawString(40, y, name)
        c.drawRightString(330, y, str(qty))
        c.drawRightString(410, y, f"{price:.2f}")
        c.drawRightString(520, y, f"{qty*price:.2f}")
        y -= 14
    y -= 10
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(520, y, f"Total: {currency} {float(inv.get('total') or 0):.2f}")
    y -= 30
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(0.05, 0.24, 0.57)
    c.drawCentredString(w / 2, 40, "OrbitBills Powered By TechSerenia")
    c.save()
    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="invoice-{inv.get("invoice_number","")}.pdf"'},
    )


@bp.route("/invoices/<int:invoice_id>/export/png", methods=["GET"])
@require_billing_or_admin
def export_invoice_png(invoice_id):
    """Render a simple invoice image with Pillow (server-side PNG)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return jsonify({"ok": False, "error": "Pillow not installed."}), 500

    with get_connection() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invoice not found."}), 404
        items = conn.execute(
            "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)
        ).fetchall()
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}

    inv = row_to_dict(row)
    brand = branding.get("brand_name") or "TechSerenia"
    width, line_h = 800, 28
    height = 200 + max(len(list(items)), 1) * line_h + 120
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
        font_b = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
        font_s = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
    except Exception:
        font = font_b = font_s = ImageFont.load_default()

    y = 24
    draw.text((32, y), brand, fill=(11, 61, 145), font=font_b)
    y += 28
    draw.text((32, y), f"Invoice {inv.get('invoice_number','')}", fill=(90, 100, 120), font=font)
    y += 22
    draw.text((32, y), f"Client: {inv.get('client_name','')}", fill=(16, 26, 43), font=font)
    y += 30
    draw.line((32, y, width - 32, y), fill=(223, 231, 245))
    y += 12
    for it in items:
        line = f"{it['name'][:40]}  x{it['qty']}  @ {float(it['price']):.2f}  = {float(it['qty'])*float(it['price']):.2f}"
        draw.text((32, y), line, fill=(16, 26, 43), font=font_s)
        y += line_h
    y += 10
    draw.text((32, y), f"TOTAL: {float(inv.get('total') or 0):.2f}", fill=(11, 61, 145), font=font_b)
    y += 36
    draw.text((32, y), "OrbitBills Powered By TechSerenia", fill=(11, 61, 145), font=font_s)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="image/png",
        headers={"Content-Disposition": f'attachment; filename="invoice-{inv.get("invoice_number","")}.png"'},
    )


@bp.route("/billing/bootstrap", methods=["GET"])
@require_billing_or_admin
def billing_bootstrap():
    """One call for billing page: branding, active layout, open shift, tax slabs."""
    with get_connection() as conn:
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
        layout = None
        lid = branding.get("active_layout_id")
        if lid:
            row = conn.execute("SELECT * FROM invoice_layouts WHERE id = ?", (int(lid),)).fetchone()
            if row:
                layout = row_to_dict(row)
                layout["elements"] = json.loads(layout.pop("elements_json"))
        shift = conn.execute(
            "SELECT * FROM cash_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        taxes = conn.execute("SELECT * FROM tax_slabs ORDER BY percentage").fetchall()
    return jsonify({
        "ok": True,
        "branding": branding,
        "layout": layout,
        "shift": row_to_dict(shift),
        "taxSlabs": [row_to_dict(t) for t in taxes],
    })


# ===========================================================================
# POS SYNC + COUPONS + OVERRIDE + REPORTS + BULK + CHECKOUT
# (client_statement already defined above — do not redefine)
# ===========================================================================

@bp.route("/pos-sync", methods=["GET"])
@require_billing_or_admin
def pos_sync():
    with get_connection() as conn:
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
        products = conn.execute(
            "SELECT id, name, brand, category, unit, price, stock, low_stock_limit, tax_slab_id, sku, barcode, photo_path, color, cost_price FROM products ORDER BY name"
        ).fetchall()
        low = [
            row_to_dict(p) for p in products
            if int(p["stock"] or 0) <= (p["low_stock_limit"] if p["low_stock_limit"] is not None else default_limit)
        ]
        clients = conn.execute(
            "SELECT id, name, email, phone, credit_balance, price_list_id FROM clients ORDER BY name"
        ).fetchall()
        recent = conn.execute(
            "SELECT id, invoice_number, client_name, total, status, created_at, amount_paid FROM invoices ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
        held = conn.execute("SELECT COUNT(*) c FROM held_bills").fetchone()["c"]
        shift = conn.execute(
            "SELECT * FROM cash_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        taxes = conn.execute("SELECT * FROM tax_slabs ORDER BY percentage").fetchall()
        layout = None
        lid = branding.get("active_layout_id")
        if lid:
            try:
                lrow = conn.execute("SELECT * FROM invoice_layouts WHERE id = ?", (int(lid),)).fetchone()
                if lrow:
                    layout = row_to_dict(lrow)
                    layout["elements"] = json.loads(layout.pop("elements_json") or "[]")
            except Exception:
                layout = None
        prod_fp = conn.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(stock),0) s, COALESCE(SUM(price),0) p FROM products"
        ).fetchone()
        inv_fp = conn.execute("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM invoices").fetchone()
        fingerprint = f"p{prod_fp['c']}-{prod_fp['s']}-{int(prod_fp['p']*100)}-i{inv_fp['c']}-{inv_fp['m']}-h{held}"
        today = conn.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM invoices WHERE date(created_at) = date('now')"
        ).fetchone()
        try:
            coupons = conn.execute(
                "SELECT id, code, name, discount_type, value, min_order, max_discount, active, expires_at FROM coupons WHERE active = 1 ORDER BY code"
            ).fetchall()
        except Exception:
            coupons = []
    return jsonify({
        "ok": True,
        "fingerprint": fingerprint,
        "branding": branding,
        "layout": layout,
        "taxSlabs": [row_to_dict(t) for t in taxes],
        "products": [row_to_dict(p) for p in products],
        "clients": [row_to_dict(c) for c in clients],
        "lowStock": low,
        "recentInvoices": [row_to_dict(r) for r in recent],
        "heldCount": held,
        "shift": row_to_dict(shift) if shift else None,
        "today": {"count": today["c"], "total": today["s"]},
        "coupons": [row_to_dict(c) for c in coupons],
        "serverTime": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
    })


@bp.route("/coupons", methods=["GET"])
@require_billing_or_admin
def list_coupons():
    with get_connection() as conn:
        try:
            rows = conn.execute("SELECT * FROM coupons ORDER BY created_at DESC").fetchall()
        except Exception:
            rows = []
    return jsonify({"ok": True, "coupons": [row_to_dict(r) for r in rows]})


@bp.route("/coupons", methods=["POST"])
@require_admin
def create_coupon():
    data = _json_body()
    code = (data.get("code") or "").strip().upper()
    if not code:
        return jsonify({"ok": False, "error": "Code required."}), 400
    dtype = (data.get("discountType") or data.get("discount_type") or "pct").lower()
    if dtype not in ("pct", "flat"):
        return jsonify({"ok": False, "error": "Type must be pct or flat."}), 400
    with get_connection() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO coupons (code, name, discount_type, value, min_order, max_discount, max_uses, active, expires_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    code, data.get("name", ""), dtype, float(data.get("value", 0) or 0),
                    float(data.get("minOrder", data.get("min_order", 0)) or 0),
                    float(data["maxDiscount"]) if data.get("maxDiscount") not in (None, "") else None,
                    int(data["maxUses"]) if data.get("maxUses") not in (None, "") else None,
                    1 if data.get("active", True) else 0,
                    data.get("expiresAt") or data.get("expires_at") or "",
                ),
            )
        except Exception:
            return jsonify({"ok": False, "error": "Code may already exist."}), 400
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.route("/coupons/<int:cid>", methods=["PUT"])
@require_admin
def update_coupon(cid):
    data = _json_body()
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM coupons WHERE id = ?", (cid,)).fetchone():
            return jsonify({"ok": False, "error": "Not found."}), 404
        conn.execute(
            """UPDATE coupons SET name=?, discount_type=?, value=?, min_order=?, max_discount=?,
               max_uses=?, active=?, expires_at=? WHERE id=?""",
            (
                data.get("name", ""),
                (data.get("discountType") or data.get("discount_type") or "pct"),
                float(data.get("value", 0) or 0),
                float(data.get("minOrder", data.get("min_order", 0)) or 0),
                float(data["maxDiscount"]) if data.get("maxDiscount") not in (None, "") else None,
                int(data["maxUses"]) if data.get("maxUses") not in (None, "") else None,
                1 if data.get("active", True) else 0,
                data.get("expiresAt") or data.get("expires_at") or "",
                cid,
            ),
        )
    return jsonify({"ok": True})


@bp.route("/coupons/<int:cid>", methods=["DELETE"])
@require_admin
def delete_coupon(cid):
    with get_connection() as conn:
        conn.execute("DELETE FROM coupons WHERE id = ?", (cid,))
    return jsonify({"ok": True})


@bp.route("/coupons/validate", methods=["POST"])
@require_billing_or_admin
def validate_coupon():
    data = _json_body()
    code = (data.get("code") or "").strip().upper()
    subtotal = float(data.get("subtotal", 0) or 0)
    if not code:
        return jsonify({"ok": False, "error": "Enter a coupon code."}), 400
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM coupons WHERE code = ?", (code,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Invalid coupon."}), 400
        c = row_to_dict(row)
        if not c.get("active"):
            return jsonify({"ok": False, "error": "Coupon inactive."}), 400
        if c.get("expires_at"):
            try:
                if datetime.utcnow().strftime("%Y-%m-%d") > str(c["expires_at"])[:10]:
                    return jsonify({"ok": False, "error": "Coupon expired."}), 400
            except Exception:
                pass
        if c.get("max_uses") is not None and int(c.get("used_count") or 0) >= int(c["max_uses"]):
            return jsonify({"ok": False, "error": "Coupon fully redeemed."}), 400
        if subtotal < float(c.get("min_order") or 0):
            return jsonify({"ok": False, "error": f"Minimum order {c['min_order']}."}), 400
        if c["discount_type"] == "pct":
            disc = subtotal * (float(c["value"]) / 100.0)
        else:
            disc = float(c["value"])
        if c.get("max_discount") is not None:
            disc = min(disc, float(c["max_discount"]))
        disc = min(disc, subtotal)
    return jsonify({"ok": True, "code": code, "discount": round(disc, 2),
                    "discountType": c["discount_type"], "value": c["value"], "name": c.get("name") or code})


@bp.route("/coupons/redeem", methods=["POST"])
@require_billing_or_admin
def redeem_coupon():
    data = _json_body()
    code = (data.get("code") or "").strip().upper()
    with get_connection() as conn:
        conn.execute("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?", (code,))
    return jsonify({"ok": True})


@bp.route("/price-override", methods=["POST"])
@require_billing_or_admin
def price_override():
    data = _json_body()
    pin = str(data.get("pin") or "")
    product_id = data.get("productId")
    new_price = float(data.get("newPrice", 0) or 0)
    reason = (data.get("reason") or "").strip()
    with get_connection() as conn:
        branding = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM branding_settings").fetchall()}
        if (branding.get("allow_price_override") or "yes") != "yes":
            return jsonify({"ok": False, "error": "Price override disabled."}), 403
        expected = str(branding.get("price_override_pin") or "1234")
        if pin != expected:
            return jsonify({"ok": False, "error": "Wrong override PIN."}), 403
        row = None
        if product_id:
            row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        old = float(row["price"]) if row else float(data.get("oldPrice", 0) or 0)
        name = row["name"] if row else (data.get("productName") or "")
        try:
            conn.execute(
                """INSERT INTO price_overrides (product_id, product_name, old_price, new_price, user_email, reason)
                   VALUES (?,?,?,?,?,?)""",
                (product_id, name, old, new_price, session.get("email", ""), reason),
            )
        except Exception:
            pass
    return jsonify({"ok": True, "newPrice": new_price})


@bp.route("/price-override/log", methods=["GET"])
@require_admin
def price_override_log():
    """History of every price override made from the billing counter --
    who did it, on which product, old price -> new price, and why."""
    limit = min(int(request.args.get("limit", 200) or 200), 500)
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM price_overrides ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return jsonify({"ok": True, "overrides": [row_to_dict(r) for r in rows]})


@bp.route("/low-stock", methods=["GET"])
@require_billing_or_admin
def low_stock_center():
    """Read-only low-stock list for the admin/billing UI (separate from
    /low-stock/alert, which actually sends an email)."""
    with get_connection() as conn:
        setting = conn.execute(
            "SELECT value FROM branding_settings WHERE key = 'default_low_stock_limit'"
        ).fetchone()
        default_limit = int(setting["value"]) if setting and setting["value"] else 5
        rows = conn.execute(
            """
            SELECT id, name, sku, brand, category, stock, price,
                   COALESCE(low_stock_limit, ?) as limit_val
            FROM products WHERE stock <= COALESCE(low_stock_limit, ?)
            ORDER BY stock ASC
            """,
            (default_limit, default_limit),
        ).fetchall()
    return jsonify({"ok": True, "items": [row_to_dict(r) for r in rows], "defaultLimit": default_limit})


@bp.route("/reports/day-close", methods=["GET"])
@require_billing_or_admin
def day_close_report():
    day = (request.args.get("date") or "").strip() or datetime.utcnow().strftime("%Y-%m-%d")
    with get_connection() as conn:
        invs = conn.execute(
            "SELECT * FROM invoices WHERE date(created_at) = date(?) ORDER BY created_at", (day,)
        ).fetchall()
        payments = conn.execute(
            """SELECT p.* FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE date(p.created_at) = date(?)""", (day,)
        ).fetchall()
        returns = conn.execute(
            "SELECT * FROM returns WHERE date(created_at) = date(?)", (day,)
        ).fetchall()
        shift = conn.execute(
            "SELECT * FROM cash_shifts WHERE date(opened_at) = date(?) OR status = 'open' ORDER BY id DESC LIMIT 5",
            (day,),
        ).fetchall()
    inv_list = [row_to_dict(i) for i in invs]
    total_sales = sum(float(i.get("total") or 0) for i in inv_list)
    paid = sum(float(i.get("total") or 0) for i in inv_list if (i.get("status") or "") == "paid")
    unpaid = sum(float(i.get("total") or 0) for i in inv_list if (i.get("status") or "") == "unpaid")
    partial = sum(float(i.get("total") or 0) for i in inv_list if (i.get("status") or "") == "partial")
    by_method = {}
    for p in payments:
        m = (p["method"] or "other").lower()
        by_method[m] = by_method.get(m, 0) + float(p["amount"] or 0)
    if not by_method:
        for i in inv_list:
            ap = float(i.get("amount_paid") or 0)
            if ap <= 0 and (i.get("status") or "") == "paid":
                ap = float(i.get("total") or 0)
            if ap > 0:
                by_method["recorded"] = by_method.get("recorded", 0) + ap
    ret_total = sum(float(r["total"] or 0) for r in returns)
    return jsonify({
        "ok": True, "date": day, "invoiceCount": len(inv_list),
        "totalSales": round(total_sales, 2), "paid": round(paid, 2),
        "unpaid": round(unpaid, 2), "partial": round(partial, 2),
        "returnsTotal": round(ret_total, 2), "returnCount": len(returns),
        "byPaymentMethod": {k: round(v, 2) for k, v in by_method.items()},
        "invoices": inv_list, "shifts": [row_to_dict(s) for s in shift],
        "netSales": round(total_sales - ret_total, 2),
    })


@bp.route("/products/bulk-update", methods=["POST"])
@require_admin
def bulk_update_products():
    data = _json_body()
    mode = (data.get("mode") or "").strip()
    value = data.get("value")
    ids = data.get("productIds") or []
    category = (data.get("category") or "").strip()
    brand = (data.get("brand") or "").strip()
    if not mode:
        return jsonify({"ok": False, "error": "mode required."}), 400
    with get_connection() as conn:
        q = "SELECT * FROM products WHERE 1=1"
        params = []
        if ids:
            q += " AND id IN (%s)" % ",".join("?" * len(ids))
            params.extend(ids)
        if category:
            q += " AND category = ?"
            params.append(category)
        if brand:
            q += " AND brand = ?"
            params.append(brand)
        rows = conn.execute(q, params).fetchall()
        updated = 0
        for r in rows:
            pid = r["id"]
            if mode == "price_pct":
                new_p = round(float(r["price"] or 0) * (1 + float(value or 0) / 100.0), 2)
                conn.execute("UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_p, pid))
            elif mode == "price_flat":
                new_p = max(0, float(r["price"] or 0) + float(value or 0))
                conn.execute("UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_p, pid))
            elif mode == "set_price":
                conn.execute("UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (float(value or 0), pid))
            elif mode == "stock_add":
                _adjust_stock(conn, pid, int(float(value or 0)), reason="Bulk stock add", ref_type="bulk", ref_id=None)
            elif mode == "stock_set":
                cur = int(r["stock"] or 0)
                target = int(float(value or 0))
                _adjust_stock(conn, pid, target - cur, reason="Bulk stock set", ref_type="bulk", ref_id=None)
            elif mode == "category":
                conn.execute("UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (str(value or ""), pid))
            elif mode == "brand":
                conn.execute("UPDATE products SET brand = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (str(value or ""), pid))
            elif mode == "set_cost":
                conn.execute("UPDATE products SET cost_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (float(value or 0), pid))
            else:
                return jsonify({"ok": False, "error": "Unknown mode."}), 400
            updated += 1
    return jsonify({"ok": True, "updated": updated})


@bp.route("/reports/profit-margin", methods=["GET"])
@require_admin
def profit_margin_report():
    days = int(request.args.get("days", 30))
    with get_connection() as conn:
        products = conn.execute("SELECT id, name, sku, price, cost_price, stock FROM products").fetchall()
        sales = conn.execute(
            """
            SELECT ii.product_id, SUM(ii.qty) qty, SUM(ii.qty * ii.price) revenue
            FROM invoice_items ii
            JOIN invoices inv ON inv.id = ii.invoice_id
            WHERE ii.product_id IS NOT NULL AND date(inv.created_at) >= date('now', ?)
            GROUP BY ii.product_id
            """,
            (f"-{days} days",),
        ).fetchall()
        sold = {r["product_id"]: r for r in sales}
        out = []
        total_rev = total_cost = 0
        for p in products:
            pid = p["id"]
            s = sold.get(pid)
            qty = float(s["qty"]) if s else 0
            rev = float(s["revenue"]) if s else 0
            cost_u = float(p["cost_price"] or 0)
            cost = cost_u * qty
            margin = rev - cost
            margin_pct = (margin / rev * 100) if rev else None
            list_margin = ((float(p["price"]) - cost_u) / float(p["price"]) * 100) if float(p["price"] or 0) else None
            total_rev += rev
            total_cost += cost
            out.append({
                "productId": pid, "name": p["name"], "sku": p["sku"], "price": p["price"],
                "costPrice": cost_u, "stock": p["stock"], "soldQty": qty,
                "revenue": round(rev, 2), "cost": round(cost, 2), "margin": round(margin, 2),
                "marginPct": round(margin_pct, 1) if margin_pct is not None else None,
                "listMarginPct": round(list_margin, 1) if list_margin is not None else None,
            })
        out.sort(key=lambda x: x["margin"], reverse=True)
    return jsonify({
        "ok": True, "days": days,
        "totalRevenue": round(total_rev, 2), "totalCost": round(total_cost, 2),
        "totalMargin": round(total_rev - total_cost, 2), "products": out,
    })


@bp.route("/invoices/checkout", methods=["POST"])
@require_billing_or_admin
def checkout_invoice():
    data = _json_body()
    items = data.get("items") or []
    if not items:
        return jsonify({"ok": False, "error": "Add at least one line item."}), 400
    invoice_number = (data.get("invoiceNumber") or f"INV-{int(time.time())}").strip()
    client_id = data.get("clientId")
    client_name = (data.get("clientName") or "").strip()
    discount = float(data.get("discount", 0) or 0)
    credit_applied = float(data.get("creditApplied", 0) or 0)
    coupon_code = (data.get("couponCode") or "").strip().upper()
    notes = data.get("notes", "")
    splits = data.get("splits") or []
    payments = data.get("payments") or []

    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM invoices WHERE invoice_number = ?", (invoice_number,)).fetchone():
            return jsonify({"ok": False, "error": "Invoice number already exists."}), 400
        if client_id and not client_name:
            c = conn.execute("SELECT name FROM clients WHERE id = ?", (client_id,)).fetchone()
            client_name = c["name"] if c else ""
        if coupon_code:
            crow = conn.execute("SELECT * FROM coupons WHERE code = ?", (coupon_code,)).fetchone()
            if crow:
                conn.execute("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?", (coupon_code,))
                notes = (notes + f" | Coupon {coupon_code}").strip(" |")
        if credit_applied and client_id:
            client = conn.execute("SELECT credit_balance FROM clients WHERE id = ?", (client_id,)).fetchone()
            if client:
                avail = float(client["credit_balance"] or 0)
                credit_applied = min(credit_applied, max(0, avail))
                new_bal = avail - credit_applied
                conn.execute("UPDATE clients SET credit_balance = ? WHERE id = ?", (new_bal, client_id))
                if credit_applied:
                    conn.execute(
                        "INSERT INTO credit_transactions (client_id, amount, reason, balance_after) VALUES (?,?,?,?)",
                        (client_id, -credit_applied, f"Applied to invoice {invoice_number}", new_bal),
                    )
        subtotal, tax_amount, total = _calc_invoice_totals(items, discount, credit_applied)
        layout_id = data.get("layoutId")
        if not layout_id:
            s = conn.execute("SELECT value FROM branding_settings WHERE key = 'active_layout_id'").fetchone()
            layout_id = int(s["value"]) if s and s["value"] else None
        amount_paid = sum(float(p.get("amount", 0) or 0) for p in payments)
        if amount_paid <= 0:
            amount_paid = float(data.get("amountPaid", 0) or 0)
        if amount_paid + 0.001 >= total:
            status = "paid"
            amount_paid = total
        elif amount_paid > 0:
            status = "partial"
        else:
            status = data.get("status") or "unpaid"
        if splits:
            notes = (notes + " | Split: " + "; ".join(
                f"{s.get('label','Person')}: {float(s.get('amount',0)):.2f}" for s in splits
            )).strip(" |")
        cur = conn.execute(
            """INSERT INTO invoices (invoice_number, client_id, client_name, subtotal, discount,
                tax_amount, total, credit_applied, status, notes, layout_id, amount_paid)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (invoice_number, client_id, client_name, subtotal, discount, tax_amount, total,
             credit_applied, status, notes, layout_id, amount_paid),
        )
        invoice_id = cur.lastrowid
        for it in items:
            conn.execute(
                "INSERT INTO invoice_items (invoice_id, product_id, name, qty, price, tax_percent) VALUES (?,?,?,?,?,?)",
                (invoice_id, it.get("productId"), it.get("name", ""), it.get("qty", 1),
                 it.get("price", 0), it.get("taxPercent", 0)),
            )
        _deduct_invoice_stock(conn, items)
        for p in payments:
            amt = float(p.get("amount", 0) or 0)
            if amt <= 0:
                continue
            conn.execute(
                "INSERT INTO payments (invoice_id, amount, method, reference, notes) VALUES (?,?,?,?,?)",
                (invoice_id, amt, (p.get("method") or "cash"), p.get("reference", ""), p.get("notes", p.get("label", ""))),
            )
        shift = conn.execute(
            "SELECT * FROM cash_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if shift:
            cash_add = sum(float(p.get("amount", 0) or 0) for p in payments if (p.get("method") or "").lower() == "cash")
            card_add = sum(float(p.get("amount", 0) or 0) for p in payments if (p.get("method") or "").lower() == "card")
            upi_add = sum(float(p.get("amount", 0) or 0) for p in payments if (p.get("method") or "").lower() == "upi")
            other_add = sum(float(p.get("amount", 0) or 0) for p in payments if (p.get("method") or "").lower() not in ("cash", "card", "upi"))
            conn.execute(
                """UPDATE cash_shifts SET cash_sales=COALESCE(cash_sales,0)+?, card_sales=COALESCE(card_sales,0)+?,
                   upi_sales=COALESCE(upi_sales,0)+?, other_sales=COALESCE(other_sales,0)+? WHERE id=?""",
                (cash_add, card_add, upi_add, other_add, shift["id"]),
            )
    return jsonify({
        "ok": True, "id": invoice_id, "invoiceNumber": invoice_number, "total": total,
        "status": status, "amountPaid": amount_paid, "subtotal": subtotal,
        "taxAmount": tax_amount, "discount": discount,
    })

