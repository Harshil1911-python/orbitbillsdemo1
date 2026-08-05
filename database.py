"""
database.py
------------
Storage layer for TechSerenia's sign in / sign up system.

CHANGE (2026): authentication no longer lives in SQLite. The client asked to
move auth off SQLite entirely and run it against IndexedDB in the browser
(techserenia_pos -> "users" store, see Db.js), seeded with one fixed default
admin account (admin@techserenia.com) so the client always has a way in.

IndexedDB is browser-only storage though -- a Python/Flask process on the
server can never read or write it directly, and it is strictly per-browser
(clear site data / a different device and it's gone). Two things depend on
having a real, cross-device account list:
  1. /api/login and /api/signup, which still run on the server so the admin
     panel's access control (require_admin / require_billing_or_admin in
     admin.py) keeps working exactly as before -- those checks read
     Flask's session, and only the server can set that safely.
  2. Anyone signing in from a browser other than the one an account was
     created on.

So this module keeps the same job (verify/create/list/update accounts) but
now backs onto a plain JSON file instead of SQLite -- no database engine at
all. The browser mirrors this into IndexedDB (via Db.js) purely as a local,
offline-friendly cache; the JSON file here remains the real, cross-device
source of truth. See the note at the top of Db.js for the client side of
this.
"""

import json
import hashlib
import hmac
import os
import sqlite3
import threading
from contextlib import contextmanager

# ---------------------------------------------------------------------------
# SQLite connection for admin.py's OWN business tables (products, clients,
# invoices, tax slabs, branding, etc.) -- this is completely separate from
# authentication and was never part of the "move auth off SQLite" request,
# so it's kept exactly as it was. admin.py imports both DB_PATH and
# get_connection() from this module to build those tables.
# ---------------------------------------------------------------------------
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "techserenia.db")


@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Authentication storage -- JSON file, not SQLite (see module docstring).
# ---------------------------------------------------------------------------
USERS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "techserenia_users.json")

_LOCK = threading.Lock()

# "admin" is intentionally not selectable from the public sign-up form (see
# signin.html) -- there is exactly one admin account, seeded below. It can
# still be assigned from inside the admin panel itself if truly needed.
# NOTE: "billing" and "accountant" also get one fixed seeded account each
# (see DEFAULT_USERS below), same idea as the admin one -- a guaranteed way
# in for each of those roles. Unlike admin, more billing/accountant accounts
# can still be created freely through the public sign-up form.
VALID_ROLES = {"admin", "billing", "accountant", "client"}
PUBLIC_SIGNUP_ROLES = {"billing", "accountant", "client"}

# Where each role lands after signing in.
ROLE_REDIRECTS = {
    "admin": "/admin-dashboard.html",
    "billing": "/billing.html",
    "accountant": "/accountant-dashboard.html",
    "client": "/client-portal.html",
}

# Fixed default accounts, handed to the client so they always have a way in
# for each of these three roles, even before they've created any other
# accounts. "client" has no fixed default -- clients are expected to be
# created ad hoc (by the admin, or via public sign-up).
DEFAULT_ADMIN_EMAIL = "admin@techserenia.com"
DEFAULT_ADMIN_PASSWORD = "TechSerenia@2026"
DEFAULT_ADMIN_NAME = "Admin"

DEFAULT_USERS = [
    {"name": "Admin", "email": "admin@techserenia.com", "password": "TechSerenia@2026", "role": "admin"},
    {"name": "Billing", "email": "billing@techserenia.com", "password": "TechSerenia@2026", "role": "billing"},
    {"name": "Accountant", "email": "accountant@techserenia.com", "password": "TechSerenia@2026", "role": "accountant"},
]


def _hash_password(password: str, salt: bytes = None):
    """PBKDF2-based password hashing. Returns (hash_hex, salt_hex)."""
    if salt is None:
        salt = os.urandom(16)
    pw_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
    return pw_hash.hex(), salt.hex()


def hash_password(password: str, salt: bytes = None):
    """Public wrapper around the internal PBKDF2 hasher, for reuse by admin.py."""
    return _hash_password(password, salt)


def _read_all():
    if not os.path.exists(USERS_PATH):
        return {"next_id": 1, "users": []}
    with open(USERS_PATH, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return {"next_id": 1, "users": []}


def _write_all(data):
    tmp_path = USERS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, USERS_PATH)


def init_db():
    """Create the JSON store if it doesn't exist yet, and seed the fixed
    default accounts (admin, billing, accountant) so the client always has
    a way in for each of those roles. Each default is only added if an
    account with that exact email doesn't already exist, so this is safe
    to call on every startup."""
    with _LOCK:
        data = _read_all()
        existing_emails = {u["email"] for u in data["users"]}
        changed = False
        for default in DEFAULT_USERS:
            if default["email"] in existing_emails:
                continue
            pw_hash, salt = _hash_password(default["password"])
            data["users"].append({
                "id": data["next_id"],
                "name": default["name"],
                "email": default["email"],
                "password_hash": pw_hash,
                "salt": salt,
                "role": default["role"],
                "created_at": "seed",
            })
            data["next_id"] += 1
            changed = True
        if changed:
            _write_all(data)


def create_user(name: str, email: str, password: str, role: str, allow_admin: bool = False):
    """
    Create a new user account. Returns (user_dict, error_message).
    On success error_message is None; on failure user_dict is None.

    allow_admin=False (the default) blocks creating additional admin
    accounts through this function, since the project is designed around a
    single, fixed admin account. admin.py's own "add user" endpoint can
    still pass allow_admin=True if the signed-in admin genuinely wants to
    hand out a second admin login.
    """
    email = email.strip().lower()
    role = role.strip().lower()

    if not name or not email or not password or not role:
        return None, "All fields are required."
    if role not in VALID_ROLES:
        return None, "That role isn't recognized."
    if role == "admin" and not allow_admin:
        return None, "There's already an admin account for this project."
    if email in {u["email"] for u in DEFAULT_USERS}:
        return None, "That email is reserved for a default account."
    if len(password) < 6:
        return None, "Password must be at least 6 characters."

    pw_hash, salt = _hash_password(password)

    with _LOCK:
        data = _read_all()
        if any(u["email"] == email for u in data["users"]):
            return None, "An account with that email already exists."
        user_id = data["next_id"]
        data["users"].append({
            "id": user_id,
            "name": name.strip(),
            "email": email,
            "password_hash": pw_hash,
            "salt": salt,
            "role": role,
            "created_at": "now",
        })
        data["next_id"] += 1
        _write_all(data)

    return {"id": user_id, "name": name.strip(), "email": email, "role": role}, None


def verify_user(email: str, password: str):
    """
    Check credentials. Returns (user_dict, error_message).
    On success error_message is None; on failure user_dict is None.
    """
    email = email.strip().lower()

    data = _read_all()
    row = next((u for u in data["users"] if u["email"] == email), None)

    if row is None:
        return None, "No account found with that email."

    salt = bytes.fromhex(row["salt"])
    expected_hash, _ = _hash_password(password, salt)

    if not hmac.compare_digest(expected_hash, row["password_hash"]):
        return None, "Incorrect password."

    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}, None


def redirect_for_role(role: str) -> str:
    return ROLE_REDIRECTS.get(role, "/index.html")


# ---------------------------------------------------------------------------
# Used by admin.py's /api/admin/users endpoints -- unchanged signatures, so
# admin.py and admin-dashboard.html needed no changes for this switch.
# ---------------------------------------------------------------------------

def list_users():
    """Return every user account (without password hashes)."""
    data = _read_all()
    return [
        {"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "created_at": u["created_at"]}
        for u in sorted(data["users"], key=lambda u: u["id"], reverse=True)
    ]


def get_user_by_id(user_id: int):
    data = _read_all()
    row = next((u for u in data["users"] if u["id"] == user_id), None)
    if row is None:
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"], "created_at": row["created_at"]}


def delete_user(user_id: int):
    with _LOCK:
        data = _read_all()
        target = next((u for u in data["users"] if u["id"] == user_id), None)
        if target is None:
            return False
        if target["role"] == "admin":
            # Guard rail: never let the panel delete the last admin account
            # and lock everyone out.
            remaining_admins = sum(1 for u in data["users"] if u["role"] == "admin" and u["id"] != user_id)
            if remaining_admins == 0:
                return False
        data["users"] = [u for u in data["users"] if u["id"] != user_id]
        _write_all(data)
        return True


def update_user_password(user_id: int, new_password: str):
    """Reset a user's password. Returns (ok, error_message)."""
    if not new_password or len(new_password) < 6:
        return False, "Password must be at least 6 characters."
    pw_hash, salt = _hash_password(new_password)
    with _LOCK:
        data = _read_all()
        row = next((u for u in data["users"] if u["id"] == user_id), None)
        if row is None:
            return False, "User not found."
        row["password_hash"] = pw_hash
        row["salt"] = salt
        _write_all(data)
    return True, None


def update_user_role(user_id: int, new_role: str):
    new_role = (new_role or "").strip().lower()
    if new_role not in VALID_ROLES:
        return False, "That role isn't recognized."
    with _LOCK:
        data = _read_all()
        row = next((u for u in data["users"] if u["id"] == user_id), None)
        if row is None:
            return False, "User not found."
        if row["role"] == "admin" and new_role != "admin":
            remaining_admins = sum(1 for u in data["users"] if u["role"] == "admin" and u["id"] != user_id)
            if remaining_admins == 0:
                return False, "Can't demote the only admin account."
        row["role"] = new_role
        _write_all(data)
    return True, None
