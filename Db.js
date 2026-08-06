/*
  Db.js — OrbitBills local database (IndexedDB only)
  ALL business data and auth live on the device. No SQLite.
  Fixed accounts: admin@ / billing@ / accountant@ techserenia.com  password TechSerenia@2026
*/
const TS_DB_NAME = "techserenia_pos";
const TS_DB_VERSION = 4;
const TS_DEFAULT_USERS = [
  { name: "Admin", email: "admin@techserenia.com", password: "TechSerenia@2026", role: "admin" },
  { name: "Billing", email: "billing@techserenia.com", password: "TechSerenia@2026", role: "billing" },
  { name: "Accountant", email: "accountant@techserenia.com", password: "TechSerenia@2026", role: "accountant" },
];
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
      const ensure = (name, keyPath, autoInc) => {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: keyPath || "id", autoIncrement: !!autoInc });
      };
      ensure("products", "id", true);
      ensure("clients", "id", true);
      ensure("invoices", "id", true);
      ensure("settings", "key", false);
      if (!db.objectStoreNames.contains("users")) {
        const s = db.createObjectStore("users", { keyPath: "email" });
        s.createIndex("role", "role", { unique: false });
      }
      ["tax_slabs","suppliers","purchases","inventory_movements","payments","quotations",
       "product_variants","product_batches","saved_codes","cash_shifts","held_bills",
       "price_lists","price_list_items","returns","coupons","price_overrides",
       "invoice_layouts","credit_transactions","meta"].forEach(n => ensure(n, "id", true));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsGetAll(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function tsGet(storeName, key) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function tsPut(storeName, value) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tsAdd(storeName, value) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tsDelete(storeName, key) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function tsClear(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function tsCount(storeName) {
  const db = await tsOpenDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tsHashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  const usedSaltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  return { hashHex, saltHex: usedSaltHex };
}

async function tsGetUserByEmail(email) { return tsGet("users", (email || "").trim().toLowerCase()); }
async function tsGetAllUsers() { return tsGetAll("users"); }
async function tsPutUser({ id, name, email, role, password, passwordHash, salt, createdAt }) {
  email = (email || "").trim().toLowerCase();
  let record = (await tsGetUserByEmail(email)) || {};
  if (password) {
    const hashed = await tsHashPassword(password);
    passwordHash = hashed.hashHex; salt = hashed.saltHex;
  }
  record = { ...record, id: id ?? record.id ?? Date.now(), name: name ?? record.name, email,
    role: role ?? record.role, passwordHash: passwordHash ?? record.passwordHash, salt: salt ?? record.salt,
    createdAt: createdAt ?? record.createdAt ?? new Date().toISOString() };
  await tsPut("users", record);
  return record;
}
async function tsDeleteUserByEmail(email) { await tsDelete("users", (email || "").trim().toLowerCase()); }
async function tsVerifyUserLocally(email, password) {
  const record = await tsGetUserByEmail(email);
  if (!record || !record.passwordHash) return null;
  const { hashHex } = await tsHashPassword(password, record.salt);
  if (hashHex !== record.passwordHash) return null;
  const { passwordHash, salt, ...safe } = record;
  return safe;
}
async function tsSeedDefaultAdmin() {
  for (const user of TS_DEFAULT_USERS) {
    if (await tsGetUserByEmail(user.email)) continue;
    await tsPutUser({ name: user.name, email: user.email, role: user.role, password: user.password, createdAt: "seed" });
  }
}

async function tsGetSetting(key, fallback) {
  const row = await tsGet("settings", key);
  return row ? row.value : fallback;
}
async function tsSetSetting(key, value) { await tsPut("settings", { key, value }); }
async function tsGetAllSettings() {
  const rows = await tsGetAll("settings");
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function tsSeedDefaults() {
  await tsSeedDefaultAdmin();
  if ((await tsCount("tax_slabs")) === 0) {
    for (const [name, percentage, is_default] of [["GST 0%",0,0],["GST 5%",5,0],["GST 12%",12,1],["GST 18%",18,0],["GST 28%",28,0]])
      await tsAdd("tax_slabs", { name, percentage, is_default, created_at: new Date().toISOString() });
  }
  const defaults = {
    brand_name: "TechSerenia", brand_tagline: "OrbitBills", brand_address: "", brand_email: "", brand_phone: "",
    accent_color: "#0b3d91", footer_note: "Thank you for your business!", show_techserenia_logo: "yes",
    show_orbitbills_branding: "yes", active_layout_id: "", default_low_stock_limit: "5", currency_symbol: "₹",
    price_override_pin: "1234", max_discount_pct: "50", allow_price_override: "yes",
    upi_id: "", upi_name: "", payment_link_note: "Pay via UPI using the QR or link",
    whatsapp_enabled: "no", low_stock_alert_email: "", low_stock_alert_enabled: "no",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!(await tsGet("settings", k))) await tsSetSetting(k, v);
  }
  if ((await tsCount("invoice_layouts")) === 0) {
    const classic = [
      { id: "logo", type: "logo", x: 30, y: 30, w: 90, h: 90 },
      { id: "brand", type: "brand_name", x: 130, y: 40, w: 300, h: 30 },
      { id: "address", type: "brand_address", x: 130, y: 74, w: 300, h: 50 },
      { id: "invmeta", type: "invoice_meta", x: 440, y: 40, w: 130, h: 80 },
      { id: "billto", type: "bill_to", x: 30, y: 150, w: 260, h: 80 },
      { id: "table", type: "items_table", x: 30, y: 250, w: 540, h: 280 },
      { id: "totals", type: "totals", x: 350, y: 550, w: 220, h: 100 },
      { id: "footer", type: "footer", x: 30, y: 700, w: 540, h: 40 },
      { id: "orbit", type: "orbit_brand", x: 30, y: 750, w: 200, h: 30 },
    ];
    const id = await tsAdd("invoice_layouts", { name: "Classic", is_preset: 1, elements_json: JSON.stringify(classic), created_at: new Date().toISOString() });
    await tsSetSetting("active_layout_id", String(id));
  }
}

const TS_BC = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("orbitbills-sync") : null;
function tsNotify(type, detail) {
  try { if (TS_BC) TS_BC.postMessage({ type: type || "data_changed", detail, at: Date.now() }); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("orbitbills-sync", { detail: { type, detail } })); } catch (e) {}
}
function tsOnSync(handler) {
  if (TS_BC) TS_BC.onmessage = (ev) => handler(ev.data);
  window.addEventListener("orbitbills-sync", (ev) => handler(ev.detail));
}

function tsDeviceId() {
  let id = localStorage.getItem("ts_device_id");
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "dev-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    localStorage.setItem("ts_device_id", id);
  }
  return id;
}
function tsSaveSession(user) {
  const payload = { email: user.email, role: user.role, name: user.name || "", id: user.id, signedInAt: Date.now(), deviceId: tsDeviceId() };
  localStorage.setItem("ts_session", JSON.stringify(payload));
  return payload;
}
function tsGetSession() {
  try { return JSON.parse(localStorage.getItem("ts_session") || "null"); } catch (e) { return null; }
}
function tsClearSession() { localStorage.removeItem("ts_session"); }
async function tsLogin(email, password) {
  await tsSeedDefaults();
  const user = await tsVerifyUserLocally(email, password);
  if (!user) return { ok: false, error: "Incorrect email or password." };
  const session = tsSaveSession(user);
  return { ok: true, role: user.role, name: user.name, email: user.email, redirect: TS_ROLE_REDIRECTS[user.role] || "/index.html", session };
}
function tsLogout() { tsClearSession(); return { ok: true, redirect: "/signin.html" }; }
function tsWhoami() {
  const s = tsGetSession();
  if (!s || !s.email) return { ok: false };
  return { ok: true, email: s.email, role: s.role, name: s.name };
}
function tsRequireRole(...roles) {
  const s = tsWhoami();
  return s.ok && roles.includes(s.role);
}

function tsNowIso() { return new Date().toISOString(); }
function tsCalcInvoiceTotals(items, discount, creditApplied) {
  let subtotal = 0, tax_amount = 0;
  for (const it of items || []) {
    const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
    subtotal += line;
    tax_amount += line * ((Number(it.taxPercent ?? it.tax_percent) || 0) / 100);
  }
  discount = Number(discount) || 0;
  creditApplied = Number(creditApplied) || 0;
  const total = Math.max(0, subtotal + tax_amount - discount - creditApplied);
  return { subtotal: Math.round(subtotal * 100) / 100, tax_amount: Math.round(tax_amount * 100) / 100, total: Math.round(total * 100) / 100, discount, credit_applied: creditApplied };
}
async function tsAdjustStock(productId, delta, reason, refType, refId) {
  if (!productId) return;
  const p = await tsGet("products", productId);
  if (!p) return;
  const bal = (Number(p.stock) || 0) + (Number(delta) || 0);
  p.stock = bal; p.updated_at = tsNowIso();
  await tsPut("products", p);
  await tsAdd("inventory_movements", { product_id: productId, product_name: p.name || "", delta: Number(delta) || 0, reason: reason || "", ref_type: refType || "", ref_id: refId || null, balance_after: bal, created_at: tsNowIso() });
}

async function tsLocalApi(path, options) {
  await tsSeedDefaults();
  const method = ((options && options.method) || "GET").toUpperCase();
  let body = (options && options.body) || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const pathOnly = path.replace(/^\//, "").split("?")[0];
  const parts = pathOnly.split("/").filter(Boolean);
  const query = {};
  const qIdx = path.indexOf("?");
  if (qIdx >= 0) new URLSearchParams(path.slice(qIdx + 1)).forEach((v, k) => { query[k] = v; });

  if (parts[0] === "overview" && method === "GET") {
    const products = await tsGetAll("products");
    const clients = await tsGetAll("clients");
    const invoices = await tsGetAll("invoices");
    const defaultLimit = parseInt((await tsGetSetting("default_low_stock_limit", "5")) || "5", 10);
    const low = products.filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit));
    const revenuePaid = invoices.filter(i => i.status === "paid").reduce((s, i) => s + (Number(i.total) || 0), 0);
    const revenueUnpaid = invoices.filter(i => i.status === "unpaid" || i.status === "partial")
      .reduce((s, i) => s + Math.max(0, (Number(i.total) || 0) - (Number(i.amount_paid) || 0)), 0);
    return { ok: true, stats: { products: products.length, clients: clients.length, invoices: invoices.length, lowStock: low.length,
      totalClientCredits: clients.reduce((s, c) => s + (Number(c.credit_balance) || 0), 0), revenuePaid, revenueUnpaid },
      lowStockProducts: low.slice(0, 20) };
  }

  if (parts[0] === "pos-sync" && method === "GET") {
    const products = await tsGetAll("products");
    const clients = await tsGetAll("clients");
    const invoices = await tsGetAll("invoices");
    const taxSlabs = await tsGetAll("tax_slabs");
    const branding = await tsGetAllSettings();
    const held = await tsGetAll("held_bills");
    const shifts = await tsGetAll("cash_shifts");
    const openShift = shifts.find(s => s.status === "open") || null;
    const defaultLimit = parseInt(branding.default_low_stock_limit || "5", 10);
    const lowStock = products.filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit));
    let layout = null;
    if (branding.active_layout_id) {
      const L = await tsGet("invoice_layouts", parseInt(branding.active_layout_id, 10));
      if (L) layout = { ...L, elements: JSON.parse(L.elements_json || "[]") };
    }
    return { ok: true, fingerprint: [products.length, clients.length, invoices.length, held.length, openShift && openShift.id].join(":"),
      products, clients, recentInvoices: invoices.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 30),
      taxSlabs, branding, layout, heldCount: held.length, shift: openShift, lowStock };
  }

  if (parts[0] === "tax-slabs") {
    if (method === "GET") return { ok: true, taxSlabs: await tsGetAll("tax_slabs") };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("tax_slabs", { name: body.name || "Tax", percentage: Number(body.percentage) || 0, is_default: body.is_default ? 1 : 0, created_at: tsNowIso() });
      tsNotify("tax_slabs"); return { ok: true, id };
    }
    if (parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT") {
        const row = await tsGet("tax_slabs", id); if (!row) return { ok: false, error: "Not found." };
        Object.assign(row, { name: body.name ?? row.name, percentage: body.percentage != null ? Number(body.percentage) : row.percentage, is_default: body.is_default != null ? (body.is_default ? 1 : 0) : row.is_default });
        await tsPut("tax_slabs", row); tsNotify("tax_slabs"); return { ok: true };
      }
      if (method === "DELETE") { await tsDelete("tax_slabs", id); tsNotify("tax_slabs"); return { ok: true }; }
    }
  }

  if (parts[0] === "products") {
    if (method === "GET" && parts.length === 1) return { ok: true, products: await tsGetAll("products") };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("products", {
        name: body.name || "Product", brand: body.brand || "", store_type: body.storeType || body.store_type || "other",
        category: body.category || "", unit: body.unit || "pcs", price: Number(body.price) || 0,
        cost_price: Number(body.costPrice ?? body.cost_price) || 0, stock: Number(body.stock) || 0,
        low_stock_limit: body.lowStockLimit != null ? Number(body.lowStockLimit) : (body.low_stock_limit != null ? Number(body.low_stock_limit) : null),
        tax_slab_id: body.taxSlabId || body.tax_slab_id || null, sku: body.sku || "", barcode: body.barcode || "",
        hsn_code: body.hsnCode || body.hsn_code || "", notes: body.notes || "", photo_path: body.photo_path || body.photo || null,
        color: body.color || "", created_at: tsNowIso(), updated_at: tsNowIso(),
      });
      tsNotify("products"); return { ok: true, id };
    }
    if (parts[1] === "bulk-update" && method === "POST") {
      let products = await tsGetAll("products");
      const ids = body.productIds || [];
      if (ids.length) products = products.filter(p => ids.includes(p.id));
      let updated = 0;
      for (const p of products) {
        const mode = body.mode;
        if (mode === "price_pct") p.price = Math.round((Number(p.price) || 0) * (1 + Number(body.value || 0) / 100) * 100) / 100;
        else if (mode === "price_flat") p.price = Math.max(0, (Number(p.price) || 0) + Number(body.value || 0));
        else if (mode === "set_price") p.price = Number(body.value || 0);
        else if (mode === "stock_add") { await tsAdjustStock(p.id, Number(body.value || 0), "Bulk add", "bulk"); updated++; continue; }
        else if (mode === "stock_set") { await tsAdjustStock(p.id, Number(body.value || 0) - (Number(p.stock) || 0), "Bulk set", "bulk"); updated++; continue; }
        else if (mode === "category") p.category = String(body.value || "");
        else if (mode === "brand") p.brand = String(body.value || "");
        else if (mode === "set_cost") p.cost_price = Number(body.value || 0);
        else return { ok: false, error: "Unknown mode." };
        p.updated_at = tsNowIso(); await tsPut("products", p); updated++;
      }
      tsNotify("products"); return { ok: true, updated };
    }
    if (parts.length === 2 && !["export","clear","bulk-update"].includes(parts[1])) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT") {
        const row = await tsGet("products", id); if (!row) return { ok: false, error: "Not found." };
        const map = { name: body.name, brand: body.brand, category: body.category, unit: body.unit,
          price: body.price != null ? Number(body.price) : undefined,
          cost_price: body.costPrice != null ? Number(body.costPrice) : (body.cost_price != null ? Number(body.cost_price) : undefined),
          stock: body.stock != null ? Number(body.stock) : undefined,
          low_stock_limit: body.lowStockLimit !== undefined ? (body.lowStockLimit === "" || body.lowStockLimit == null ? null : Number(body.lowStockLimit)) : body.low_stock_limit,
          tax_slab_id: body.taxSlabId ?? body.tax_slab_id, sku: body.sku, barcode: body.barcode,
          hsn_code: body.hsnCode ?? body.hsn_code, notes: body.notes, color: body.color, store_type: body.storeType ?? body.store_type };
        for (const [k, v] of Object.entries(map)) if (v !== undefined) row[k] = v;
        row.updated_at = tsNowIso(); await tsPut("products", row); tsNotify("products"); return { ok: true };
      }
      if (method === "DELETE") { await tsDelete("products", id); tsNotify("products"); return { ok: true }; }
    }
  }

  if (parts[0] === "clients") {
    if (method === "GET" && parts.length === 1) return { ok: true, clients: await tsGetAll("clients") };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("clients", { name: body.name || "Client", email: body.email || "", phone: body.phone || "",
        address: body.address || "", gstin: body.gstin || "", notes: body.notes || "", credit_balance: 0, created_at: tsNowIso() });
      tsNotify("clients"); return { ok: true, id };
    }
    if (parts.length >= 2) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT" && parts.length === 2) {
        const row = await tsGet("clients", id); if (!row) return { ok: false, error: "Not found." };
        for (const k of ["name","email","phone","address","gstin","notes","price_list_id"]) if (body[k] !== undefined) row[k] = body[k];
        await tsPut("clients", row); tsNotify("clients"); return { ok: true };
      }
      if (method === "DELETE" && parts.length === 2) { await tsDelete("clients", id); tsNotify("clients"); return { ok: true }; }
      if (parts[2] === "credits" && method === "POST") {
        const row = await tsGet("clients", id); if (!row) return { ok: false, error: "Not found." };
        const amount = Number(body.amount) || 0;
        row.credit_balance = (Number(row.credit_balance) || 0) + amount;
        await tsPut("clients", row);
        await tsAdd("credit_transactions", { client_id: id, amount, reason: body.reason || "", balance_after: row.credit_balance, created_at: tsNowIso() });
        tsNotify("clients"); return { ok: true, balance: row.credit_balance };
      }
      if (parts[2] === "statement" && method === "GET") {
        const client = await tsGet("clients", id); if (!client) return { ok: false, error: "Not found." };
        const invoices = (await tsGetAll("invoices")).filter(i => i.client_id === id);
        const totalBilled = invoices.reduce((s, i) => s + (Number(i.total) || 0), 0);
        const totalPaid = invoices.reduce((s, i) => s + (Number(i.amount_paid) || (i.status === "paid" ? Number(i.total) : 0)), 0);
        return { ok: true, client, invoices, summary: { totalBilled, totalInvoiced: totalBilled, totalPaid, outstanding: Math.max(0, totalBilled - totalPaid), totalUnpaid: Math.max(0, totalBilled - totalPaid), creditBalance: Number(client.credit_balance) || 0 } };
      }
      if (parts[2] === "prices" && method === "GET") return { ok: true, prices: {} };
      if (parts[2] === "history" && method === "GET") {
        const client = await tsGet("clients", id); if (!client) return { ok: false, error: "Not found." };
        const invoices = (await tsGetAll("invoices")).filter(i => i.client_id === id);
        const creditTransactions = (await tsGetAll("credit_transactions")).filter(c => c.client_id === id);
        return { ok: true, client, invoices, creditTransactions, credits: creditTransactions, totalSpent: invoices.reduce((s, i) => s + (Number(i.total) || 0), 0) };
      }
    }
  }

  if (parts[0] === "invoices") {
    if (method === "GET" && parts.length === 1) return { ok: true, invoices: (await tsGetAll("invoices")).sort((a, b) => (b.id || 0) - (a.id || 0)) };
    if (method === "GET" && parts.length === 2) {
      const inv = await tsGet("invoices", parseInt(parts[1], 10));
      if (!inv) return { ok: false, error: "Not found." };
      let layout = null;
      if (inv.layout_id) { const L = await tsGet("invoice_layouts", inv.layout_id); if (L) layout = { ...L, elements: JSON.parse(L.elements_json || "[]") }; }
      return { ok: true, invoice: inv, layout };
    }
    if ((method === "POST" && parts.length === 1) || (parts[1] === "checkout" && method === "POST")) {
      const items = body.items || [];
      if (!items.length) return { ok: false, error: "Add at least one line item." };
      const invoice_number = (body.invoiceNumber || body.invoice_number || "INV-" + Date.now()).trim();
      if ((await tsGetAll("invoices")).find(i => i.invoice_number === invoice_number)) return { ok: false, error: "Invoice number already exists." };
      let client_id = body.clientId ?? body.client_id ?? null;
      let client_name = (body.clientName || body.client_name || "").trim();
      if (client_id && !client_name) { const c = await tsGet("clients", client_id); client_name = c ? c.name : ""; }
      let discount = Number(body.discount) || 0;
      let credit_applied = Number(body.creditApplied ?? body.credit_applied) || 0;
      let notes = body.notes || "";
      const coupon_code = (body.couponCode || "").trim().toUpperCase();
      if (coupon_code) {
        const crow = (await tsGetAll("coupons")).find(c => c.code === coupon_code);
        if (crow) { crow.used_count = (crow.used_count || 0) + 1; await tsPut("coupons", crow); notes = (notes + " | Coupon " + coupon_code).trim(); }
      }
      if (credit_applied && client_id) {
        const client = await tsGet("clients", client_id);
        if (client) {
          const avail = Number(client.credit_balance) || 0;
          credit_applied = Math.min(credit_applied, Math.max(0, avail));
          client.credit_balance = avail - credit_applied;
          await tsPut("clients", client);
          if (credit_applied) await tsAdd("credit_transactions", { client_id, amount: -credit_applied, reason: "Applied to " + invoice_number, balance_after: client.credit_balance, created_at: tsNowIso() });
        }
      }
      const totals = tsCalcInvoiceTotals(items, discount, credit_applied);
      let layout_id = body.layoutId || body.layout_id || null;
      if (!layout_id) { const s = await tsGetSetting("active_layout_id", ""); layout_id = s ? parseInt(s, 10) : null; }
      const payments = body.payments || [];
      let amount_paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) || Number(body.amountPaid) || 0;
      let status = body.status || "unpaid";
      if (amount_paid + 0.001 >= totals.total) { status = "paid"; amount_paid = totals.total; }
      else if (amount_paid > 0) status = "partial";
      const inv = { invoice_number, client_id, client_name, subtotal: totals.subtotal, discount: totals.discount, tax_amount: totals.tax_amount,
        total: totals.total, credit_applied: totals.credit_applied, status, notes, layout_id, amount_paid, due_date: body.dueDate || "",
        items: items.map(it => ({ product_id: it.productId ?? it.product_id ?? null, name: it.name || "", qty: Number(it.qty) || 1, price: Number(it.price) || 0, tax_percent: Number(it.taxPercent ?? it.tax_percent) || 0 })),
        created_at: tsNowIso() };
      const invoice_id = await tsAdd("invoices", inv);
      for (const it of inv.items) if (it.product_id) await tsAdjustStock(it.product_id, -it.qty, "Sale " + invoice_number, "invoice", invoice_id);
      for (const p of payments) {
        const amt = Number(p.amount) || 0; if (amt <= 0) continue;
        await tsAdd("payments", { invoice_id, amount: amt, method: (p.method || "cash").toLowerCase(), reference: p.reference || "", notes: p.notes || "", created_at: tsNowIso() });
      }
      const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
      if (shift) {
        for (const p of payments) {
          const m = (p.method || "").toLowerCase(), amt = Number(p.amount) || 0;
          if (m === "cash") shift.cash_sales = (shift.cash_sales || 0) + amt;
          else if (m === "card") shift.card_sales = (shift.card_sales || 0) + amt;
          else if (m === "upi") shift.upi_sales = (shift.upi_sales || 0) + amt;
          else shift.other_sales = (shift.other_sales || 0) + amt;
        }
        await tsPut("cash_shifts", shift);
      }
      tsNotify("invoices");
      return { ok: true, id: invoice_id, invoiceNumber: invoice_number, total: totals.total, status, amountPaid: amount_paid, subtotal: totals.subtotal, taxAmount: totals.tax_amount, discount: totals.discount };
    }
    if (parts.length === 3 && parts[2] === "status" && method === "POST") {
      const inv = await tsGet("invoices", parseInt(parts[1], 10)); if (!inv) return { ok: false, error: "Not found." };
      inv.status = body.status || inv.status; if (inv.status === "paid") inv.amount_paid = inv.total;
      await tsPut("invoices", inv); tsNotify("invoices"); return { ok: true };
    }
    if (parts.length === 2 && method === "DELETE") {
      const id = parseInt(parts[1], 10); const inv = await tsGet("invoices", id);
      if (inv && inv.items) for (const it of inv.items) if (it.product_id) await tsAdjustStock(it.product_id, it.qty, "Invoice deleted", "invoice", id);
      await tsDelete("invoices", id); tsNotify("invoices"); return { ok: true };
    }
    if (parts.length === 3 && parts[2] === "share" && method === "POST") return { ok: true, token: "local-" + parts[1], url: "#local-share-" + parts[1] };
  }

  if (parts[0] === "branding") {
    if (method === "GET") return { ok: true, branding: await tsGetAllSettings() };
    if (method === "POST") {
      for (const [k, v] of Object.entries(body)) if (k !== "ok") await tsSetSetting(k, v == null ? "" : String(v));
      tsNotify("branding"); return { ok: true };
    }
  }

  if (parts[0] === "invoice-layouts") {
    if (method === "GET") return { ok: true, layouts: (await tsGetAll("invoice_layouts")).map(L => ({ ...L, elements: JSON.parse(L.elements_json || "[]") })) };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("invoice_layouts", { name: body.name || "Custom", is_preset: 0, elements_json: JSON.stringify(body.elements || []), created_at: tsNowIso() });
      return { ok: true, id };
    }
    if (parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT") {
        const row = await tsGet("invoice_layouts", id); if (!row) return { ok: false, error: "Not found." };
        if (body.name != null) row.name = body.name; if (body.elements) row.elements_json = JSON.stringify(body.elements);
        await tsPut("invoice_layouts", row); return { ok: true };
      }
      if (method === "DELETE") { await tsDelete("invoice_layouts", id); return { ok: true }; }
    }
  }

  if (parts[0] === "held-bills") {
    if (method === "GET" && parts.length === 1) return { ok: true, heldBills: await tsGetAll("held_bills") };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("held_bills", { label: body.label || "", client_id: body.clientId || null, client_name: body.clientName || "",
        cart: body.cart || [], discount: Number(body.discount) || 0, credit_applied: Number(body.creditApplied) || 0, notes: body.notes || "",
        created_by: (tsWhoami().email || ""), created_at: tsNowIso() });
      tsNotify("held"); return { ok: true, id };
    }
    if (parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (method === "GET") { const h = await tsGet("held_bills", id); return h ? { ok: true, heldBill: h } : { ok: false, error: "Not found." }; }
      if (method === "DELETE") { await tsDelete("held_bills", id); tsNotify("held"); return { ok: true }; }
    }
  }

  if (parts[0] === "shifts") {
    if (parts[1] === "current" && method === "GET") return { ok: true, shift: (await tsGetAll("cash_shifts")).find(s => s.status === "open") || null };
    if (parts[1] === "open" && method === "POST") {
      const who = tsWhoami();
      const id = await tsAdd("cash_shifts", { user_email: who.email || "", user_name: who.name || "", opened_at: tsNowIso(), closed_at: null,
        opening_float: Number(body.openingFloat) || 0, closing_cash: null, expected_cash: null, cash_sales: 0, card_sales: 0, upi_sales: 0, other_sales: 0, variance: null, notes: "", status: "open" });
      tsNotify("shifts"); return { ok: true, id };
    }
    if (parts.length === 3 && parts[2] === "close" && method === "POST") {
      const shift = await tsGet("cash_shifts", parseInt(parts[1], 10)); if (!shift) return { ok: false, error: "Not found." };
      const closing = Number(body.closingCash) || 0;
      shift.closing_cash = closing; shift.expected_cash = (Number(shift.opening_float) || 0) + (Number(shift.cash_sales) || 0);
      shift.variance = closing - shift.expected_cash; shift.closed_at = tsNowIso(); shift.status = "closed";
      await tsPut("cash_shifts", shift); tsNotify("shifts"); return { ok: true, variance: shift.variance };
    }
    if (method === "GET") return { ok: true, shifts: await tsGetAll("cash_shifts") };
  }

  if (parts[0] === "returns") {
    if (method === "GET") return { ok: true, returns: await tsGetAll("returns") };
    if (method === "POST") {
      const items = body.items || [];
      const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
      const return_number = "RET-" + Date.now();
      const id = await tsAdd("returns", { return_number, invoice_id: body.invoiceId || null, client_id: body.clientId || null, client_name: body.clientName || "",
        total, restock: body.restock ? 1 : 0, credit_to_client: body.creditToClient ? 1 : 0, notes: body.notes || "", items, created_at: tsNowIso() });
      if (body.restock) for (const it of items) if (it.productId) await tsAdjustStock(it.productId, Number(it.qty) || 0, "Return " + return_number, "return", id);
      if (body.creditToClient && body.clientId) {
        const client = await tsGet("clients", body.clientId);
        if (client) { client.credit_balance = (Number(client.credit_balance) || 0) + total; await tsPut("clients", client);
          await tsAdd("credit_transactions", { client_id: body.clientId, amount: total, reason: "Return " + return_number, balance_after: client.credit_balance, created_at: tsNowIso() }); }
      }
      tsNotify("returns"); return { ok: true, id, returnNumber: return_number };
    }
  }

  if (parts[0] === "coupons") {
    if (method === "GET" && parts.length === 1) return { ok: true, coupons: await tsGetAll("coupons") };
    if (method === "POST" && parts.length === 1) {
      const code = (body.code || "").trim().toUpperCase(); if (!code) return { ok: false, error: "Code required." };
      try {
        const id = await tsAdd("coupons", { code, name: body.name || "", discount_type: (body.discountType || "pct").toLowerCase(), value: Number(body.value) || 0,
          min_order: Number(body.minOrder) || 0, max_discount: body.maxDiscount != null && body.maxDiscount !== "" ? Number(body.maxDiscount) : null,
          max_uses: body.maxUses != null && body.maxUses !== "" ? parseInt(body.maxUses, 10) : null, used_count: 0, active: 1, expires_at: body.expiresAt || "", created_at: tsNowIso() });
        return { ok: true, id };
      } catch (e) { return { ok: false, error: "Code may already exist." }; }
    }
    if (parts[1] === "validate" && method === "POST") {
      const code = (body.code || "").trim().toUpperCase(); const subtotal = Number(body.subtotal) || 0;
      const c = (await tsGetAll("coupons")).find(x => x.code === code);
      if (!c) return { ok: false, error: "Invalid coupon." };
      if (!c.active) return { ok: false, error: "Coupon inactive." };
      if (c.expires_at && new Date().toISOString().slice(0, 10) > String(c.expires_at).slice(0, 10)) return { ok: false, error: "Coupon expired." };
      if (c.max_uses != null && (c.used_count || 0) >= c.max_uses) return { ok: false, error: "Coupon fully redeemed." };
      if (subtotal < (Number(c.min_order) || 0)) return { ok: false, error: "Minimum order " + c.min_order };
      let disc = c.discount_type === "pct" ? subtotal * (Number(c.value) / 100) : Number(c.value);
      if (c.max_discount != null) disc = Math.min(disc, Number(c.max_discount));
      disc = Math.min(disc, subtotal);
      return { ok: true, code, discount: Math.round(disc * 100) / 100, discountType: c.discount_type, value: c.value, name: c.name || code };
    }
    if (parts.length === 2 && method === "PUT") {
      const row = await tsGet("coupons", parseInt(parts[1], 10)); if (!row) return { ok: false, error: "Not found." };
      Object.assign(row, { name: body.name ?? row.name, discount_type: body.discountType || row.discount_type, value: body.value != null ? Number(body.value) : row.value,
        min_order: body.minOrder != null ? Number(body.minOrder) : row.min_order, active: body.active != null ? (body.active ? 1 : 0) : row.active });
      await tsPut("coupons", row); return { ok: true };
    }
    if (parts.length === 2 && method === "DELETE") { await tsDelete("coupons", parseInt(parts[1], 10)); return { ok: true }; }
  }

  if (parts[0] === "price-override") {
    if (parts[1] === "log" && method === "GET") return { ok: true, overrides: (await tsGetAll("price_overrides")).sort((a, b) => (b.id || 0) - (a.id || 0)) };
    if (method === "POST") {
      const branding = await tsGetAllSettings();
      if ((branding.allow_price_override || "yes") !== "yes") return { ok: false, error: "Price override disabled." };
      if (String(body.pin || "") !== String(branding.price_override_pin || "1234")) return { ok: false, error: "Wrong override PIN." };
      let old = Number(body.oldPrice) || 0, name = body.productName || "";
      if (body.productId) { const p = await tsGet("products", body.productId); if (p) { old = Number(p.price) || 0; name = p.name; } }
      await tsAdd("price_overrides", { product_id: body.productId, product_name: name, old_price: old, new_price: Number(body.newPrice) || 0, user_email: tsWhoami().email || "", reason: body.reason || "", created_at: tsNowIso() });
      return { ok: true, newPrice: Number(body.newPrice) || 0 };
    }
  }

  if (parts[0] === "low-stock" && method === "GET") {
    const products = await tsGetAll("products");
    const defaultLimit = parseInt((await tsGetSetting("default_low_stock_limit", "5")) || "5", 10);
    const items = products.filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit))
      .map(p => ({ ...p, limit_val: p.low_stock_limit != null ? p.low_stock_limit : defaultLimit })).sort((a, b) => (a.stock || 0) - (b.stock || 0));
    return { ok: true, items, defaultLimit };
  }

  if (parts[0] === "suppliers") {
    if (method === "GET") return { ok: true, suppliers: await tsGetAll("suppliers") };
    if (method === "POST") { const id = await tsAdd("suppliers", { name: body.name || "", email: body.email || "", phone: body.phone || "", address: body.address || "", gstin: body.gstin || "", notes: body.notes || "", created_at: tsNowIso() }); return { ok: true, id }; }
    if (parts.length === 2 && method === "DELETE") { await tsDelete("suppliers", parseInt(parts[1], 10)); return { ok: true }; }
    if (parts.length === 2 && method === "PUT") { const row = await tsGet("suppliers", parseInt(parts[1], 10)); if (!row) return { ok: false, error: "Not found." }; Object.assign(row, body); await tsPut("suppliers", row); return { ok: true }; }
  }

  if (parts[0] === "purchases") {
    if (method === "GET") return { ok: true, purchases: await tsGetAll("purchases") };
    if (method === "POST") {
      const items = body.items || [];
      let subtotal = 0, tax_amount = 0;
      for (const it of items) { const line = (Number(it.qty) || 0) * (Number(it.cost) || 0); subtotal += line; tax_amount += line * ((Number(it.taxPercent) || 0) / 100); }
      const id = await tsAdd("purchases", { purchase_number: body.purchaseNumber || "PO-" + Date.now(), supplier_id: body.supplierId || null, supplier_name: body.supplierName || "",
        subtotal, tax_amount, total: subtotal + tax_amount, status: body.status || "received", notes: body.notes || "", items, created_at: tsNowIso() });
      for (const it of items) if (it.productId) await tsAdjustStock(it.productId, Number(it.qty) || 0, "Purchase", "purchase", id);
      return { ok: true, id };
    }
    if (parts.length === 2 && method === "DELETE") { await tsDelete("purchases", parseInt(parts[1], 10)); return { ok: true }; }
  }

  if (parts[0] === "price-lists") {
    if (method === "GET") {
      const lists = await tsGetAll("price_lists"); const items = await tsGetAll("price_list_items");
      return { ok: true, priceLists: lists.map(l => ({ ...l, items: items.filter(i => i.price_list_id === l.id) })) };
    }
    if (method === "POST") { const id = await tsAdd("price_lists", { name: body.name || "List", notes: "", created_at: tsNowIso() }); return { ok: true, id }; }
    if (parts.length === 2 && method === "DELETE") { await tsDelete("price_lists", parseInt(parts[1], 10)); return { ok: true }; }
  }

  if (parts[0] === "reports") {
    if (parts[1] === "day-close" && method === "GET") {
      const day = (query.date || new Date().toISOString().slice(0, 10)).trim();
      const invs = (await tsGetAll("invoices")).filter(i => (i.created_at || "").slice(0, 10) === day);
      const payments = (await tsGetAll("payments")).filter(p => (p.created_at || "").slice(0, 10) === day);
      const returns = (await tsGetAll("returns")).filter(r => (r.created_at || "").slice(0, 10) === day);
      const totalSales = invs.reduce((s, i) => s + (Number(i.total) || 0), 0);
      const paid = invs.filter(i => i.status === "paid").reduce((s, i) => s + (Number(i.total) || 0), 0);
      const unpaid = invs.filter(i => i.status === "unpaid").reduce((s, i) => s + (Number(i.total) || 0), 0);
      const partial = invs.filter(i => i.status === "partial").reduce((s, i) => s + (Number(i.total) || 0), 0);
      const by_method = {};
      for (const p of payments) { const m = (p.method || "other").toLowerCase(); by_method[m] = (by_method[m] || 0) + (Number(p.amount) || 0); }
      const ret_total = returns.reduce((s, r) => s + (Number(r.total) || 0), 0);
      return { ok: true, date: day, invoiceCount: invs.length, totalSales, paid, unpaid, partial, returnsTotal: ret_total, returnCount: returns.length, byPaymentMethod: by_method, invoices: invs, shifts: await tsGetAll("cash_shifts"), netSales: totalSales - ret_total };
    }
    if (parts[1] === "profit-margin" && method === "GET") {
      const days = parseInt(query.days || "30", 10); const cutoff = Date.now() - days * 86400000;
      const products = await tsGetAll("products"); const invoices = await tsGetAll("invoices");
      const sold = {};
      for (const inv of invoices) {
        if (new Date(inv.created_at || 0).getTime() < cutoff) continue;
        for (const it of inv.items || []) {
          if (!it.product_id) continue;
          if (!sold[it.product_id]) sold[it.product_id] = { qty: 0, revenue: 0 };
          sold[it.product_id].qty += Number(it.qty) || 0;
          sold[it.product_id].revenue += (Number(it.qty) || 0) * (Number(it.price) || 0);
        }
      }
      let total_rev = 0, total_cost = 0;
      const out = products.map(p => {
        const s = sold[p.id] || { qty: 0, revenue: 0 }; const cost_u = Number(p.cost_price) || 0; const cost = cost_u * s.qty; const margin = s.revenue - cost;
        total_rev += s.revenue; total_cost += cost;
        return { productId: p.id, name: p.name, sku: p.sku, price: p.price, costPrice: cost_u, stock: p.stock, soldQty: s.qty, revenue: Math.round(s.revenue * 100) / 100, cost: Math.round(cost * 100) / 100, margin: Math.round(margin * 100) / 100, marginPct: s.revenue ? Math.round((margin / s.revenue) * 1000) / 10 : null };
      }).sort((a, b) => b.margin - a.margin);
      return { ok: true, days, totalRevenue: Math.round(total_rev * 100) / 100, totalCost: Math.round(total_cost * 100) / 100, totalMargin: Math.round((total_rev - total_cost) * 100) / 100, products: out };
    }
  }

  if (parts[0] === "reorder-suggestions" && method === "GET") {
    const days = parseInt(query.days || "30", 10); const cutoff = Date.now() - days * 86400000;
    const products = await tsGetAll("products"); const invoices = await tsGetAll("invoices"); const sold = {};
    for (const inv of invoices) {
      if (new Date(inv.created_at || 0).getTime() < cutoff) continue;
      for (const it of inv.items || []) if (it.product_id) sold[it.product_id] = (sold[it.product_id] || 0) + (Number(it.qty) || 0);
    }
    const suggestions = products.map(p => {
      const soldLast = sold[p.id] || 0; const daily = soldLast / days; const suggest = Math.max(0, Math.ceil(daily * 14 - (Number(p.stock) || 0)));
      return { name: p.name, stock: p.stock, soldLastPeriod: soldLast, dailyVelocity: Math.round(daily * 100) / 100, suggestQty: suggest };
    }).filter(s => s.suggestQty > 0).sort((a, b) => b.suggestQty - a.suggestQty);
    return { ok: true, suggestions };
  }

  if (parts[0] === "batches" && parts[1] === "expiring") {
    const days = parseInt(query.days || "30", 10); const limit = Date.now() + days * 86400000;
    const batches = await tsGetAll("product_batches"); const products = await tsGetAll("products");
    const pname = Object.fromEntries(products.map(p => [p.id, p.name]));
    return { ok: true, batches: batches.filter(b => b.expiry_date && new Date(b.expiry_date).getTime() <= limit).map(b => ({ ...b, product_name: pname[b.product_id] || "" })) };
  }

  if (parts[0] === "codes") {
    if (method === "GET") return { ok: true, codes: await tsGetAll("saved_codes") };
    if (method === "POST") { const id = await tsAdd("saved_codes", { name: body.name || "Untitled", code_type: body.codeType || "qr", payload: body.payload || "", design_json: JSON.stringify(body.design || {}), created_at: tsNowIso() }); return { ok: true, id }; }
    if (parts.length === 2 && method === "DELETE") { await tsDelete("saved_codes", parseInt(parts[1], 10)); return { ok: true }; }
  }

  if (parts[0] === "database") {
    if (parts[1] === "counts") {
      const counts = {};
      for (const s of ["products","clients","invoices","suppliers","purchases","coupons","returns","held_bills"]) counts[s] = await tsCount(s);
      return { ok: true, counts };
    }
    if (parts[1] === "wipe" && method === "POST") {
      if ((body.confirm || "") !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
      const map = { products: ["products","product_variants","product_batches","inventory_movements"], clients: ["clients","credit_transactions"],
        invoices: ["invoices","payments"], purchases: ["purchases"], suppliers: ["suppliers"], coupons: ["coupons"], returns: ["returns"], held: ["held_bills"] };
      for (const cat of body.categories || []) for (const store of map[cat] || []) await tsClear(store);
      tsNotify("wipe"); return { ok: true };
    }
  }

  if (parts[0] === "users" && method === "GET") {
    return { ok: true, users: (await tsGetAllUsers()).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at })) };
  }
  if (parts[0] === "sessions" && method === "GET") {
    const s = tsGetSession();
    return { ok: true, sessions: s ? [{ id: 1, email: s.email, role: s.role, user_agent: navigator.userAgent, ip_address: "local", created_at: new Date(s.signedInAt || Date.now()).toISOString(), last_active_at: new Date().toISOString(), expires_at: "" }] : [] };
  }

  return { ok: false, error: "Local API: unhandled path " + path + " [" + method + "]" };
}

const TS_TILE_COLORS = ["#0b3d91","#2f6feb","#158a53","#b8860b","#8e44ad","#c0392b","#0f766e"];
function tsColorForName(name) {
  let hash = 0; for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return TS_TILE_COLORS[Math.abs(hash) % TS_TILE_COLORS.length];
}
if (typeof window !== "undefined") tsSeedDefaults().catch(() => {});
