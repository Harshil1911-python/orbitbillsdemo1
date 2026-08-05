"""
app.py
------
Flask backend for the TechSerenia site.

Serves the static pages (index, about, contact, sign in, and the role
dashboards) and handles account creation / sign in through database.py.
On sign in or sign up, the response tells the browser which page to redirect
to based on the account's role.

Session security
-----------------
Sign-in used to just drop `email`/`role` into Flask's signed cookie and
leave it at that. That cookie is unforgeable but not revocable -- the
server had no record of "this login is currently active", so there was no
way to see who was signed in, force a device out, expire an idle session,
or stop a copied cookie from being replayed on a different browser.

session_manager.py adds that server-side record. On every sign-in we mint
a random token there (bound to the browser via a device-id header + User
-Agent) and store *only the token* in the cookie. The before_request hook
below re-checks that token against the server-side store on every API
call -- if it's been revoked, expired, gone idle, or is being replayed
from a different device, the local Flask session is cleared and the
existing @require_admin / @require_billing_or_admin decorators in
admin.py reject the request exactly as if the person had never signed in.
"""

import os
from datetime import timedelta

from flask import Flask, request, jsonify, session, send_from_directory

import database
import session_manager
import admin as admin_module

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
# Hardcoded on purpose (per request) instead of read from an environment
# variable -- this is what signs the session cookie, so if you ever run
# more than one server process/instance for this app, they all need this
# exact same value or people's sessions will randomly stop validating.
app.secret_key = "TechSerenia-OrbitBills-9f3c7a1e2b6d4f58a0c9e7b3d1f6a8c2"

app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024  # 6MB request cap (product/brand photo uploads)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Browsers reject a Secure cookie over plain http, which would break local
# dev (http://localhost). Default this on and let a local run opt out
# explicitly, rather than defaulting off and risking it staying off in prod.
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("TECHSERENIA_INSECURE_COOKIES") != "1"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=session_manager.ABSOLUTE_SESSION_HOURS)

database.init_db()
session_manager.init_sessions_db()

# Admin panel: products, clients, tax slabs, credits, invoices, branding,
# invoice layouts, and staff/password management all live in admin.py.
app.register_blueprint(admin_module.bp)
app.register_blueprint(admin_module.uploads_bp)
admin_module.init_admin_db()


# ---------- session enforcement ----------

# Endpoints that must stay reachable without an existing valid session --
# otherwise nobody could ever sign in.
_PUBLIC_API_PATHS = {"/api/login", "/api/signup", "/api/logout", "/api/whoami"}


@app.before_request
def _enforce_server_side_session():
    if request.method == "OPTIONS":
        return
    if not request.path.startswith("/api/"):
        return  # static pages carry no privileged data of their own
    if request.path in _PUBLIC_API_PATHS:
        return

    token = session.get("session_token")
    if not token:
        # No session cookie at all (or an old one from before this change)
        # -- let the request through; the @require_admin / @require_*
        # decorators downstream will 401 it since session["role"] is unset.
        return

    device_id = request.headers.get("X-Device-Id", "")
    ok, reason, _row = session_manager.validate_session(token, request, device_id)
    if not ok:
        session.clear()


def _start_session(user: dict):
    """Shared by signup/login: mint a server-side session row and store
    only its token in the signed cookie."""
    device_id = request.headers.get("X-Device-Id", "")
    token = session_manager.create_session(user, request, device_id)
    session.clear()
    session.permanent = True
    session["email"] = user["email"]
    session["role"] = user["role"]
    session["session_token"] = token


# ---------- static pages ----------

@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:page>.html")
def static_page(page):
    """Serve any .html file in the project root (index, aboutus, contact,
    signin, admin-dashboard, accountant-dashboard, client-portal, billing, ...)."""
    filename = f"{page}.html"
    if os.path.exists(os.path.join(BASE_DIR, filename)):
        return send_from_directory(BASE_DIR, filename)
    return jsonify({"error": "Page not found"}), 404


# ---------- auth API ----------

@app.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "")
    email = data.get("email", "")
    password = data.get("password", "")
    role = data.get("role", "")

    # Public sign-up can only create billing/accountant/client accounts.
    # There is exactly one admin account (seeded by database.init_db());
    # extra admins can only be granted from inside the admin panel itself.
    if role.strip().lower() not in database.PUBLIC_SIGNUP_ROLES:
        return jsonify({"ok": False, "error": "That role isn't available for self sign-up."}), 400

    user, error = database.create_user(name, email, password, role)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    _start_session(user)

    return jsonify({
        "ok": True,
        "role": user["role"],
        "name": user["name"],
        "redirect": database.redirect_for_role(user["role"]),
    })


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "")
    password = data.get("password", "")

    user, error = database.verify_user(email, password)
    if error:
        return jsonify({"ok": False, "error": error}), 401

    _start_session(user)

    return jsonify({
        "ok": True,
        "role": user["role"],
        "name": user["name"],
        "redirect": database.redirect_for_role(user["role"]),
    })


@app.route("/api/logout", methods=["POST"])
def api_logout():
    token = session.get("session_token")
    if token:
        session_manager.revoke_session(token)
    session.clear()
    return jsonify({"ok": True, "redirect": "/signin.html"})


@app.route("/api/whoami")
def api_whoami():
    if "email" not in session:
        return jsonify({"ok": False}), 401
    return jsonify({"ok": True, "email": session["email"], "role": session["role"]})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
