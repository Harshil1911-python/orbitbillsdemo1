/*
  db.js
  -----
  Shared IndexedDB layer for OrbitBills (TechSerenia).
  Used by admin-dashboard.html, billing.html, accountant-dashboard.html and
  client-portal.html so every page reads and writes the same product/
  client/invoice/user data in the browser.

  Object stores:
    products  { id, name, brand, storeType, category, unit, price, stock, lowStockLimit, notes, color }
    clients   { id, name, email, phone, address, notes }
    invoices  { id, invoiceNumber, clientId, clientName, items, subtotal, discount, tax, total, notes, createdAt }
    settings  { key, value }  -- used for invoice design (accent color, footer note, logo toggle)
    users     { id, name, email, role, passwordHash, salt, createdAt }

  ---------------------------------------------------------------------------
  A note on the "users" store and authentication (fully local now)
  ---------------------------------------------------------------------------
  All accounts live ONLY in this browser's IndexedDB -- there is no server
  copy anymore. This is a deliberate choice: OrbitBills doesn't want to be
  liable for storing anyone's business/account data on its own servers.
  Practically this means:
    - Sign in / sign up (signin.html) check and write IndexedDB directly,
      never the network.
    - Because there's no server list of accounts, an account created on one
      device/browser will NOT exist on another device or browser. All of
      admin, billing, and accountant are expected to be opened on the same
      device, sharing this one IndexedDB.
    - "Who's currently signed in" is tracked with a tiny local session
      record (see tsSetSession/tsGetSession/tsClearSession below), not a
      server session cookie. Each dashboard page should call tsGetSession()
      on load and bounce to signin.html if there isn't one.
*/

const TS_DB_NAME = "techserenia_pos";
const TS_DB_VERSION = 2;
const TS_SESSION_KEY = "ts_session";

// Fixed default accounts, seeded into IndexedDB on first load so the
// client always has a way in for each of these roles, even before any
// other account exists.
const TS_DEFAULT_USERS = [
  { name: "Admin", email: "admin@techserenia.com", password: "TechSerenia@2026", role: "admin" },
  { name: "Billing", email: "billing@techserenia.com", password: "TechSerenia@2026", role: "billing" },
  { name: "Accountant", email: "accountant@techserenia.com", password: "TechSerenia@2026", role: "accountant" },
];

// Roles the public sign-up form may create. "admin" is deliberately
// excluded -- the only admin account is the seeded default one; a second
// one can still be created from inside the admin panel itself if needed.
const TS_PUBLIC_SIGNUP_ROLES = ["billing", "accountant", "client"];
const TS_VALID_ROLES = ["admin", "billing", "accountant", "client"];

// Where each role lands after signing in. Keep in sync with
// ROLE_REDIRECTS in database.py.
const TS_ROLE_REDIRECTS = {
  admin: "/admin-dashboard.html",
  billing: "/billing.html",
  accountant: "/accountant-dashboard.html",
  client: "/client-portal.html",
};

function tsOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TS_DB_NAME, TS_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("products")) {
        const store = db.createObjectStore("products", { keyPath: "id", autoIncrement: true });
        store.createIndex("name", "name", { unique: false });
        store.createIndex("storeType", "storeType", { unique: false });
      }
      if (!db.objectStoreNames.contains("clients")) {
        db.createObjectStore("clients", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("invoices")) {
        db.createObjectStore("invoices", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("users")) {
        const store = db.createObjectStore("users", { keyPath: "email" });
        store.createIndex("role", "role", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- password hashing (client-side, Web Crypto) ----------
// PBKDF2-SHA256, mirroring the algorithm database.py uses server-side, so
// the two stores can hold genuinely comparable hashes.
async function tsHashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  const usedSaltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  return { hashHex, saltHex: usedSaltHex };
}

// ---------- users store helpers ----------
async function tsGetUserByEmail(email) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("users", "readonly");
    const req = tx.objectStore("users").get((email || "").trim().toLowerCase());
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function tsGetAllUsers() {
  return tsGetAll("users");
}

// Writes/overwrites a local cache entry for a user. `password` is optional
// (pass it when caching a fresh sign-up/login so future offline sign-ins
// can be checked locally); omit it when just mirroring role/name changes
// made from the admin panel.
async function tsPutUser({ id, name, email, role, password, passwordHash, salt, createdAt }) {
  email = (email || "").trim().toLowerCase();
  let record = (await tsGetUserByEmail(email)) || {};
  if (password) {
    const hashed = await tsHashPassword(password);
    passwordHash = hashed.hashHex;
    salt = hashed.saltHex;
  }
  record = {
    ...record,
    id: id ?? record.id,
    name: name ?? record.name,
    email,
    role: role ?? record.role,
    passwordHash: passwordHash ?? record.passwordHash,
    salt: salt ?? record.salt,
    createdAt: createdAt ?? record.createdAt ?? Date.now(),
  };
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("users", "readwrite");
    const req = tx.objectStore("users").put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

async function tsDeleteUserByEmail(email) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("users", "readwrite");
    const req = tx.objectStore("users").delete((email || "").trim().toLowerCase());
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Checks a plaintext password against the locally cached hash. Returns the
// user record (minus password fields) on success, or null.
async function tsVerifyUserLocally(email, password) {
  const record = await tsGetUserByEmail(email);
  if (!record || !record.passwordHash) return null;
  const { hashHex } = await tsHashPassword(password, record.salt);
  if (hashHex !== record.passwordHash) return null;
  const { passwordHash, salt, ...safe } = record;
  return safe;
}

// Creates a new local account, enforcing the same rules the old server did:
// role must be one of the public sign-up roles, email must be free, and
// the password needs to be at least 6 characters. Returns {user, error} --
// on success error is null; on failure user is null.
async function tsCreateUserLocal({ name, email, password, role }) {
  name = (name || "").trim();
  email = (email || "").trim().toLowerCase();
  role = (role || "").trim().toLowerCase();

  if (!name || !email || !password || !role) {
    return { user: null, error: "All fields are required." };
  }
  if (!TS_PUBLIC_SIGNUP_ROLES.includes(role)) {
    return { user: null, error: "That role isn't recognized." };
  }
  if (password.length < 6) {
    return { user: null, error: "Password must be at least 6 characters." };
  }
  const existing = await tsGetUserByEmail(email);
  if (existing) {
    return { user: null, error: "An account with that email already exists." };
  }

  const record = await tsPutUser({ name, email, role, password, createdAt: Date.now() });
  const { passwordHash, salt, ...safe } = record;
  return { user: safe, error: null };
}

// ---------- local session (replaces the old server session cookie) ----------
// Tracks who's "signed in" on this browser. Not a security boundary by
// itself (anyone with access to this device has access to this data
// either way) -- it's just used to gate which dashboard pages are shown
// and to know who to greet / attribute actions to.
function tsSetSession(user) {
  localStorage.setItem(TS_SESSION_KEY, JSON.stringify({
    email: user.email, name: user.name, role: user.role, signedInAt: Date.now(),
  }));
}
function tsGetSession() {
  try {
    const raw = localStorage.getItem(TS_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function tsClearSession() {
  localStorage.removeItem(TS_SESSION_KEY);
}
// Call at the top of every protected dashboard page. Redirects to
// signin.html if there's no session, or if the signed-in role isn't one
// of `allowedRoles`. Returns the session object if it's fine to proceed.
function tsRequireSession(allowedRoles) {
  const session = tsGetSession();
  if (!session || (allowedRoles && !allowedRoles.includes(session.role))) {
    window.location.href = "/signin.html";
    return null;
  }
  return session;
}

// Seeds the fixed default accounts (admin, billing, accountant) into
// IndexedDB if they aren't there yet. Safe to call on every page load.
async function tsSeedDefaultAdmin() {
  for (const user of TS_DEFAULT_USERS) {
    const existing = await tsGetUserByEmail(user.email);
    if (existing) continue;
    await tsPutUser({
      name: user.name,
      email: user.email,
      role: user.role,
      password: user.password,
      createdAt: "seed",
    });
  }
}

async function tsGetAll(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsGet(storeName, key) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsPut(storeName, value) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsAdd(storeName, value) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsDelete(storeName, key) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function tsClear(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function tsCount(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// A few small deterministic colors used as tile backgrounds in the photo
// sales panel when a product has no image of its own.
const TS_TILE_COLORS = ["#0b3d91", "#2f6feb", "#158a53", "#b8860b", "#8e44ad", "#c0392b", "#0f766e"];
function tsColorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return TS_TILE_COLORS[Math.abs(hash) % TS_TILE_COLORS.length];
}