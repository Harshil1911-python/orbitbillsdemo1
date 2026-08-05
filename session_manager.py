"""
session_manager.py
-------------------
Server-side session/token store layered on top of Flask's signed session
cookie.

Why this exists
----------------
Flask's built-in `session` is just a signed (not encrypted) cookie held by
the browser -- the server keeps no record of "this login is currently
valid". That means there's no way to see who's signed in, force a device
out, expire a session after inactivity, or stop a copied cookie from being
replayed on a different browser/device. This module adds that missing
server-side half:

  - Every sign-in creates one row here (a "session"), keyed by a random,
    unguessable token (32 bytes, URL-safe). The token itself still travels
    inside Flask's signed cookie (session["session_token"]), so it can't be
    forged in transit; this module is what makes it possible to also list
    and revoke it.
  - Each session is bound to a device fingerprint: a random ID the browser
    generates once and keeps in localStorage (sent as the X-Device-Id
    header), combined with the browser's User-Agent string. Neither alone
    is a strong fingerprint -- a User-Agent is shared by everyone on the
    same browser version, and a bare device id could in principle be
    copied alongside a stolen cookie -- but together, replaying a stolen
    session token from a different browser/device won't have a matching
    pair, so it's rejected.
  - Sessions carry a sliding inactivity timeout (default 30 minutes) and an
    absolute expiry (default 7 days), and can be listed/force-revoked from
    the admin panel's Sessions page.

This intentionally doesn't attempt full hardware-level device
fingerprinting (that needs a heavier client-side library) -- it binds to
"this specific browser profile", which is what "don't let a copied session
work somewhere else" actually needs.
"""

import hashlib
import secrets
from contextlib import contextmanager
from datetime import datetime, timedelta

import database

INACTIVITY_TIMEOUT_MINUTES = 30
ABSOLUTE_SESSION_HOURS = 24 * 7  # 7 days

_TS_FORMAT = "%Y-%m-%d %H:%M:%S"


@contextmanager
def _conn():
    with database.get_connection() as conn:
        yield conn


def init_sessions_db():
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS auth_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                user_id INTEGER,
                email TEXT NOT NULL,
                role TEXT NOT NULL,
                device_hash TEXT NOT NULL,
                user_agent TEXT DEFAULT '',
                ip_address TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                last_active_at TEXT DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email)")


def _now():
    return datetime.utcnow()


def _fmt(dt):
    return dt.strftime(_TS_FORMAT)


def _parse(s):
    return datetime.strptime(s, _TS_FORMAT)


def fingerprint(req, device_id: str) -> str:
    """Hash of (per-browser random id + User-Agent). See module docstring."""
    ua = req.headers.get("User-Agent", "")
    raw = f"{device_id or ''}|{ua}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_session(user: dict, req, device_id: str) -> str:
    """Create a new server-side session row and return its token. Callers
    are expected to also put this token into Flask's signed cookie
    (session['session_token']) so it round-trips with the browser."""
    token = secrets.token_urlsafe(48)
    now = _now()
    expires = now + timedelta(hours=ABSOLUTE_SESSION_HOURS)
    device_hash = fingerprint(req, device_id)
    ua = req.headers.get("User-Agent", "")[:255]
    ip = (req.headers.get("X-Forwarded-For", "") or req.remote_addr or "")[:64]
    with _conn() as conn:
        conn.execute(
            """INSERT INTO auth_sessions
               (token, user_id, email, role, device_hash, user_agent, ip_address,
                created_at, last_active_at, expires_at, revoked)
               VALUES (?,?,?,?,?,?,?,?,?,?,0)""",
            (token, user.get("id"), user.get("email"), user.get("role"),
             device_hash, ua, ip, _fmt(now), _fmt(now), _fmt(expires)),
        )
    return token


def validate_session(token: str, req, device_id: str):
    """Returns (ok: bool, reason: str|None, row: dict|None).
    On success, slides the inactivity window forward (updates
    last_active_at). Does not raise -- callers should treat any non-ok
    result as "not signed in" and clear the client session."""
    if not token:
        return False, "no_token", None
    with _conn() as conn:
        row = conn.execute("SELECT * FROM auth_sessions WHERE token = ?", (token,)).fetchone()
        if not row:
            return False, "not_found", None
        row = dict(row)
        if row["revoked"]:
            return False, "revoked", row
        now = _now()
        if now > _parse(row["expires_at"]):
            return False, "expired", row
        if now - _parse(row["last_active_at"]) > timedelta(minutes=INACTIVITY_TIMEOUT_MINUTES):
            return False, "inactive", row
        if row["device_hash"] != fingerprint(req, device_id):
            return False, "device_mismatch", row
        conn.execute("UPDATE auth_sessions SET last_active_at = ? WHERE token = ?", (_fmt(now), token))
    return True, None, row


def revoke_session(token: str):
    if not token:
        return
    with _conn() as conn:
        conn.execute("UPDATE auth_sessions SET revoked = 1 WHERE token = ?", (token,))


def revoke_by_id(session_id: int):
    with _conn() as conn:
        conn.execute("UPDATE auth_sessions SET revoked = 1 WHERE id = ?", (session_id,))


def revoke_all_for_email(email: str, except_token: str = None):
    with _conn() as conn:
        if except_token:
            conn.execute(
                "UPDATE auth_sessions SET revoked = 1 WHERE email = ? AND token != ?",
                (email, except_token),
            )
        else:
            conn.execute("UPDATE auth_sessions SET revoked = 1 WHERE email = ?", (email,))


def get_id_by_token(token: str):
    if not token:
        return None
    with _conn() as conn:
        row = conn.execute("SELECT id FROM auth_sessions WHERE token = ?", (token,)).fetchone()
    return row["id"] if row else None


def list_active_sessions():
    """All currently-valid (not revoked, not expired) sessions across every
    user -- used by the admin Sessions panel. Does not filter by the
    inactivity timeout, since an admin should still be able to see (and
    revoke) a session that's merely gone idle, not just ones in active use."""
    now = _fmt(_now())
    with _conn() as conn:
        rows = conn.execute(
            """SELECT id, email, role, user_agent, ip_address,
                      created_at, last_active_at, expires_at
               FROM auth_sessions
               WHERE revoked = 0 AND expires_at > ?
               ORDER BY last_active_at DESC""",
            (now,),
        ).fetchall()
    return [dict(r) for r in rows]


def cleanup_expired(older_than_days: int = 3):
    """Housekeeping: permanently delete rows that expired or were revoked
    a while ago. Safe to call opportunistically (e.g. when the Sessions
    panel loads) -- it only ever removes rows that are already invalid."""
    cutoff = _fmt(_now() - timedelta(days=older_than_days))
    with _conn() as conn:
        conn.execute(
            "DELETE FROM auth_sessions WHERE (revoked = 1 OR expires_at < ?) AND created_at < ?",
            (_fmt(_now()), cutoff),
        )
