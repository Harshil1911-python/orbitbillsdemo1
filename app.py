"""
app.py — Static file server for OrbitBills (local-first IndexedDB).
All business data and auth live in the browser IndexedDB (Db.js).
Flask only serves HTML/JS/CSS/images for web deploy or Capacitor packaging.
A Render (or any host) restart never deletes user data — it is not on the server.
"""
import os
from flask import Flask, send_from_directory, jsonify

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024


@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:page>.html")
def static_page(page):
    filename = f"{page}.html"
    path = os.path.join(BASE_DIR, filename)
    if os.path.exists(path):
        return send_from_directory(BASE_DIR, filename)
    return send_from_directory(BASE_DIR, "404error.html"), 404


@app.route("/Db.js")
def db_js():
    return send_from_directory(BASE_DIR, "Db.js")


@app.route("/api/<path:rest>", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
def api_stub(rest):
    return jsonify({
        "ok": False,
        "error": "OrbitBills runs fully offline. Data is stored in IndexedDB on this device.",
        "localOnly": True,
    }), 410


@app.errorhandler(404)
def not_found(e):
    path = os.path.join(BASE_DIR, "404error.html")
    if os.path.exists(path):
        return send_from_directory(BASE_DIR, "404error.html"), 404
    return jsonify({"error": "Not found"}), 404


@app.route("/<path:filename>")
def static_asset(filename):
    """Serve images, JS, CSS, favicon, etc. from the project root."""
    path = os.path.join(BASE_DIR, filename)
    if os.path.isfile(path):
        return send_from_directory(BASE_DIR, filename)
    return send_from_directory(BASE_DIR, "404error.html"), 404


if __name__ == "__main__":
    app.run(debug=True, port=5000, host="0.0.0.0")
