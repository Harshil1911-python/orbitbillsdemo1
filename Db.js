/*
  db.js
  -----
  Shared IndexedDB layer for TechSerenia OrbitBills.
  Used by admin-dashboard.html, billing.html, accountant-dashboard.html and
  display.html so every page reads and writes the same product/client/
  invoice/user data in the browser.

  Object stores:
    products  { id, name, brand, storeType, category, unit, price, stock, lowStockLimit, notes, color }
    clients   { id, name, email, phone, address, notes }
    invoices  { id, invoiceNumber, clientId, clientName, items, subtotal, discount, tax, total, notes, createdAt }
    settings  { key, value }  -- used for invoice design (accent color, footer note, logo toggle)
    users     { id, name, email, role, passwordHash, salt, createdAt } -- see note below

  ---------------------------------------------------------------------------
  A note on the "users" store and authentication
  ---------------------------------------------------------------------------
  Sign in / sign up now checks IndexedDB locally first (fast, works offline,
  and is seeded with a fixed default admin so this project always has a way
  in on a fresh browser -- see TS_DEFAULT_ADMIN below). The real, cross-
  device account list still lives on the server (see database.py), since
  IndexedDB is per-browser storage: an account created in one browser will
  not exist in another browser or on another device until it's used there
  and synced down. signin.html and admin-dashboard.html call the helpers
  below (tsSeedDefaultAdmin, tsPutUser, tsGetUserByEmail, tsGetAllUsers,
  tsDeleteUserByEmail) to keep this local copy in sync with whatever the
  server confirms, so this store should be treated as a cache, not the
  single source of truth for who's allowed in.
*/

const TS_DB_NAME = "techserenia_pos";
const TS_DB_VERSION = 2;

// Fixed default admin, seeded into IndexedDB on first load so the client
// always has a way into the admin panel even before any other account
// exists. Keep this in sync with DEFAULT_ADMIN_* in database.py.
const TS_DEFAULT_ADMIN = {
  name: "Admin",
  email: "admin@techserenia.com",
  password: "TechSerenia@2026",
  role: "admin",
};

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
// user record (minus password fields) on success, or null. Used as an
// offline fallback -- signin.html tries the server first, and only falls
// back to this if the network request fails.
async function tsVerifyUserLocally(email, password) {
  const record = await tsGetUserByEmail(email);
  if (!record || !record.passwordHash) return null;
  const { hashHex } = await tsHashPassword(password, record.salt);
  if (hashHex !== record.passwordHash) return null;
  const { passwordHash, salt, ...safe } = record;
  return safe;
}

// Seeds the fixed default admin account into IndexedDB if it isn't there
// yet. Safe to call on every page load.
async function tsSeedDefaultAdmin() {
  const existing = await tsGetUserByEmail(TS_DEFAULT_ADMIN.email);
  if (existing) return;
  await tsPutUser({
    name: TS_DEFAULT_ADMIN.name,
    email: TS_DEFAULT_ADMIN.email,
    role: TS_DEFAULT_ADMIN.role,
    password: TS_DEFAULT_ADMIN.password,
    createdAt: "seed",
  });
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