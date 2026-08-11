/*
  Db.js — OrbitBills local database (IndexedDB only)
  ALL business data and auth live on the device. No SQLite.
  Fixed accounts: admin@ / billing@ / accountant@ techserenia.com  password TechSerenia@2026
*/
const TS_DB_NAME = "techserenia_pos";
const TS_DB_VERSION = 7;
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

const TS_ALL_STORES = [
  "products","clients","invoices","settings","users",
  "tax_slabs","suppliers","purchases","inventory_movements","payments","quotations",
  "product_variants","product_batches","saved_codes","cash_shifts","held_bills",
  "price_lists","price_list_items","returns","coupons","price_overrides",
  "invoice_layouts","credit_transactions","meta","auth_sessions",
  "cash_ledger","drawings","upi_accounts",
];

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
      TS_ALL_STORES.forEach(n => {
        if (n === "settings" || n === "users") return;
        ensure(n, "id", true);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Safe read — missing object store returns [] instead of throwing */
async function tsGetAllSafe(storeName) {
  try {
    const db = await tsOpenDB();
    if (!db.objectStoreNames.contains(storeName)) return [];
    return await tsGetAll(storeName);
  } catch (e) {
    console.warn("tsGetAllSafe", storeName, e);
    return [];
  }
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
    accent_color: "#0b3d91", footer_note: "Thank you for your business!", invoice_regulations: "Goods once sold will not be returned.\nSubject to local jurisdiction.\nE. & O.E.", show_techserenia_logo: "yes",
    show_orbitbills_branding: "yes", active_layout_id: "", default_low_stock_limit: "5", currency_symbol: "₹",
    price_override_pin: "1234", max_discount_pct: "50", allow_price_override: "yes",
    upi_id: "", upi_name: "", upi_link: "", upi_qr_image: "", qr_center_logo: "", payment_link_note: "Pay via UPI using the QR or link",
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
      { id: "footer", type: "footer_note", x: 30, y: 680, w: 540, h: 36 },
      { id: "regs", type: "regulations", x: 30, y: 720, w: 540, h: 50 },
      { id: "orbit", type: "orbit_brand", x: 30, y: 780, w: 200, h: 30 },
    ];
    const id = await tsAdd("invoice_layouts", { name: "Classic", is_preset: 1, paper_size: "a4", elements_json: JSON.stringify(classic), created_at: new Date().toISOString() });
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
  // Write session log into IndexedDB (local-first session history)
  try {
    const deviceId = session.deviceId || tsDeviceId();
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const rows = await tsGetAll("auth_sessions").catch(() => []);
    for (const r of rows || []) {
      if (r.device_id === deviceId && !r.revoked) {
        r.revoked = 0;
        r.is_current = 0;
        r.last_active_at = new Date().toISOString();
        await tsPut("auth_sessions", r);
      }
    }
    await tsAdd("auth_sessions", {
      email: user.email,
      role: user.role,
      name: user.name || "",
      device_id: deviceId,
      user_agent: String(ua).slice(0, 255),
      ip_address: "local",
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      revoked: 0,
      is_current: 1,
    });
  } catch (e) { /* store may need version bump — ignore */ }
  return { ok: true, role: user.role, name: user.name, email: user.email, redirect: TS_ROLE_REDIRECTS[user.role] || "/index.html", session };
}
function tsLogout() { tsClearSession(); return { ok: true, redirect: "/signin.html" }; }
function tsWhoami() {
  const s = tsGetSession();
  if (!s || !s.email) return { ok: false };
  // Touch current session last_active (throttled via sessionStorage)
  try {
    const key = "ts_sess_touch";
    const last = parseInt(sessionStorage.getItem(key) || "0", 10);
    if (Date.now() - last > 60000) {
      sessionStorage.setItem(key, String(Date.now()));
      tsGetAll("auth_sessions").then(rows => {
        const deviceId = tsDeviceId();
        for (const r of rows || []) {
          if (r.device_id === deviceId && !r.revoked) {
            r.last_active_at = new Date().toISOString();
            tsPut("auth_sessions", r);
          }
        }
      }).catch(() => {});
    }
  } catch (e) {}
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
async function tsAdjustStock(productId, delta, reason, refType, refId, opts) {
  if (!productId) return null;
  const p = await tsGet("products", productId);
  if (!p) return null;
  const allowNegative = opts && opts.allowNegative;
  let bal = (Number(p.stock) || 0) + (Number(delta) || 0);
  if (!allowNegative && bal < 0) {
    // Clamp at zero — never let on-hand stock go negative
    bal = 0;
  }
  p.stock = bal; p.updated_at = tsNowIso();
  await tsPut("products", p);
  await tsAdd("inventory_movements", {
    product_id: productId, product_name: p.name || "", delta: Number(delta) || 0,
    reason: reason || "", ref_type: refType || "", ref_id: refId || null,
    balance_after: bal, created_at: tsNowIso(),
  });
  return bal;
}

async function tsAdjustVariantStock(variantId, delta, reason, refType, refId, opts) {
  if (!variantId) return null;
  const v = await tsGet("product_variants", variantId);
  if (!v) return null;
  const allowNegative = opts && opts.allowNegative;
  let bal = (Number(v.stock) || 0) + (Number(delta) || 0);
  if (!allowNegative && bal < 0) bal = 0;
  v.stock = bal;
  await tsPut("product_variants", v);
  // Keep parent product stock in sync so inventory panel totals stay useful
  if (v.product_id) {
    await tsAdjustStock(v.product_id, delta, reason || ("Variant " + (v.name || variantId)), refType, refId, opts);
  }
  return bal;
}

/** Pre-check stock for a cart of line items. Returns { ok, error, shortages }. */
async function tsCheckStockAvailable(items) {
  const shortages = [];
  for (const it of items || []) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const variantId = it.variantId ?? it.variant_id ?? null;
    const productId = it.productId ?? it.product_id ?? null;
    if (variantId) {
      const v = await tsGet("product_variants", variantId);
      if (!v) { shortages.push({ name: it.name || ("Variant " + variantId), need: qty, have: 0 }); continue; }
      const have = Number(v.stock) || 0;
      if (have + 1e-9 < qty) shortages.push({ name: it.name || v.name || ("Variant " + variantId), need: qty, have });
    } else if (productId) {
      const p = await tsGet("products", productId);
      if (!p) { shortages.push({ name: it.name || ("Product " + productId), need: qty, have: 0 }); continue; }
      const have = Number(p.stock) || 0;
      if (have + 1e-9 < qty) shortages.push({ name: it.name || p.name || ("Product " + productId), need: qty, have });
    }
  }
  if (shortages.length) {
    const msg = shortages.slice(0, 4).map(s => s.name + " (need " + s.need + ", have " + s.have + ")").join("; ");
    return { ok: false, error: "Insufficient stock: " + msg, shortages };
  }
  return { ok: true, shortages: [] };
}

/** Units sold by entered weight/volume rather than discrete count */
function tsIsWeightUnit(unit) {
  const u = String(unit || "").toLowerCase().trim();
  return ["kg", "g", "gram", "grams", "litre", "liter", "l", "ml"].includes(u);
}

/** Convert tax-inclusive MRP to exclusive base price used by invoice tax calc */
async function tsResolveProductPrice(body) {
  let price = Number(body.price) || 0;
  const inclRaw = body.priceIncludesTax ?? body.price_includes_tax ?? body.taxInclusive ?? body.tax_inclusive;
  const inclusive = inclRaw === true || inclRaw === 1 || inclRaw === "1" || String(inclRaw || "").toLowerCase() === "yes" || String(inclRaw || "").toLowerCase() === "true";
  if (!inclusive || price <= 0) {
    return { price, price_includes_tax: inclusive ? 1 : 0 };
  }
  let rate = Number(body.taxPercent ?? body.tax_percent) || 0;
  if (!rate) {
    const slabId = body.taxSlabId || body.tax_slab_id;
    if (slabId) {
      const slab = await tsGet("tax_slabs", Number(slabId));
      if (slab) rate = Number(slab.percentage) || 0;
    }
  }
  if (rate > 0) {
    price = Math.round((price / (1 + rate / 100)) * 100) / 100;
  }
  return { price, price_includes_tax: 1, inclusive_mrp: Number(body.price) || 0 };
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
    const payments = await tsGetAll("payments");
    const returns = await tsGetAllSafe("returns");
    const defaultLimit = parseInt((await tsGetSetting("default_low_stock_limit", "5")) || "5", 10);
    const low = products.filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit));
    const revenuePaid = invoices.filter(i => i.status === "paid").reduce((s, i) => s + (Number(i.total) || 0), 0);
    const revenueUnpaid = invoices.filter(i => i.status === "unpaid" || i.status === "partial")
      .reduce((s, i) => s + Math.max(0, (Number(i.total) || 0) - (Number(i.amount_paid) || 0)), 0);
    // Payment method buckets: only REAL received payments (amount > 0) that belong
    // to an invoice which is paid/partial or has amount_paid > 0. Pure unpaid invoices
    // (no money taken) must not inflate Cash / Bank / Other boxes.
    const invById = {};
    for (const inv of invoices) invById[inv.id] = inv;
    let payCash = 0, payBank = 0, payOther = 0;
    for (const p of payments) {
      const amt = Number(p.amount) || 0;
      if (amt <= 0) continue;
      const inv = invById[p.invoice_id];
      if (!inv) continue; // orphan payment — skip
      const st = String(inv.status || "").toLowerCase();
      const paid = Number(inv.amount_paid) || 0;
      // Skip payments sitting on fully unpaid invoices with nothing collected
      if (st === "unpaid" && paid <= 0) continue;
      if (st !== "paid" && st !== "partial" && paid <= 0) continue;
      const m = String(p.method || "other").toLowerCase();
      if (m === "cash") payCash += amt;
      else if (m === "upi" || m === "card" || m === "bank" || m === "netbanking" || m === "neft" || m === "rtgs" || m === "imps") payBank += amt;
      else payOther += amt;
    }
    const returnsTotal = (returns || []).reduce((s, r) => s + (Number(r.total) || 0), 0);
    return { ok: true, stats: { products: products.length, clients: clients.length, invoices: invoices.length, lowStock: low.length,
      totalClientCredits: clients.reduce((s, c) => s + (Number(c.credit_balance) || 0), 0), revenuePaid, revenueUnpaid,
      paymentsCash: Math.round(payCash * 100) / 100,
      paymentsBank: Math.round(payBank * 100) / 100,
      paymentsOther: Math.round(payOther * 100) / 100,
      returnsCount: (returns || []).length,
      returnsTotal: Math.round(returnsTotal * 100) / 100 },
      lowStockProducts: low.slice(0, 20),
      recentReturns: (returns || []).slice().sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||""))).slice(0, 8) };
  }

  if (parts[0] === "pos-sync" && method === "GET") {
    const products = await tsGetAll("products");
    const clients = await tsGetAll("clients");
    const invoices = await tsGetAll("invoices");
    const taxSlabs = await tsGetAll("tax_slabs");
    const branding = await tsGetAllSettings();
    const held = await tsGetAll("held_bills");
    const shifts = await tsGetAll("cash_shifts");
    const allVariants = await tsGetAll("product_variants");
    const openShift = shifts.find(s => s.status === "open") || null;
    const defaultLimit = parseInt(branding.default_low_stock_limit || "5", 10);
    const lowStock = products.filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit));
    // Group variants by parent product for the billing UI
    const variantsByProduct = {};
    for (const v of allVariants) {
      const pid = v.product_id;
      if (!pid) continue;
      if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
      variantsByProduct[pid].push(v);
    }
    const slabById = {};
    for (const t of taxSlabs) slabById[t.id] = t;
    const productsEnriched = products.map(p => {
      const slabId = p.tax_slab_id != null && p.tax_slab_id !== "" ? Number(p.tax_slab_id) : null;
      const slab = (slabId != null && !Number.isNaN(slabId)) ? (slabById[slabId] || taxSlabs.find(t => Number(t.id) === slabId)) : null;
      const tax_percentage = slab ? (Number(slab.percentage) || 0) : (Number(p.tax_percentage) || 0);
      return {
        ...p,
        tax_slab_id: slabId,
        tax_percentage,
        has_variants: !!(variantsByProduct[p.id] && variantsByProduct[p.id].length),
        variant_count: (variantsByProduct[p.id] || []).length,
        sell_by_weight: tsIsWeightUnit(p.unit),
      };
    });
    let layout = null;
    if (branding.active_layout_id) {
      const L = await tsGet("invoice_layouts", parseInt(branding.active_layout_id, 10));
      if (L) layout = { ...L, elements: JSON.parse(L.elements_json || "[]") };
    }
    return {
      ok: true,
      fingerprint: [products.length, clients.length, invoices.length, held.length, allVariants.length, openShift && openShift.id].join(":"),
      products: productsEnriched, clients,
      recentInvoices: invoices.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 30),
      taxSlabs, branding, layout, heldCount: held.length, shift: openShift, lowStock,
      variants: allVariants, variantsByProduct,
    };
  }

  if (parts[0] === "tax-slabs") {
    if (method === "GET") return { ok: true, taxSlabs: await tsGetAll("tax_slabs") };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("tax_slabs", { name: body.name || "Tax", percentage: Number(body.percentage) || 0, is_default: (body.is_default || body.isDefault) ? 1 : 0, created_at: tsNowIso() });
      tsNotify("tax_slabs"); return { ok: true, id };
    }
    if (parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT") {
        const row = await tsGet("tax_slabs", id); if (!row) return { ok: false, error: "Not found." };
        Object.assign(row, { name: body.name ?? row.name, percentage: body.percentage != null ? Number(body.percentage) : row.percentage, is_default: (body.is_default != null || body.isDefault != null) ? ((body.is_default ?? body.isDefault) ? 1 : 0) : row.is_default });
        await tsPut("tax_slabs", row); tsNotify("tax_slabs"); return { ok: true };
      }
      if (method === "DELETE") { await tsDelete("tax_slabs", id); tsNotify("tax_slabs"); return { ok: true }; }
    }
  }

  if (parts[0] === "products") {
    if (method === "GET" && parts.length === 1) {
      let products = await tsGetAll("products");
      const allV = await tsGetAll("product_variants");
      const taxSlabs = await tsGetAll("tax_slabs");
      const slabById = {};
      for (const t of taxSlabs) slabById[t.id] = t;
      const counts = {};
      const variantStock = {};
      for (const v of allV) {
        counts[v.product_id] = (counts[v.product_id] || 0) + 1;
        variantStock[v.product_id] = (variantStock[v.product_id] || 0) + (Number(v.stock) || 0);
      }
      const q = String(query.q || query.search || "").trim().toLowerCase();
      if (q) {
        products = products.filter(p => {
          const hay = [p.name, p.brand, p.sku, p.barcode, p.category, p.hsn_code, p.notes]
            .map(x => String(x || "").toLowerCase()).join(" ");
          return hay.includes(q);
        });
      }
      // Optional: only products that have variants
      if (String(query.variants || "") === "1" || String(query.has_variants || "") === "1") {
        products = products.filter(p => counts[p.id]);
      }
      return {
        ok: true,
        products: products.map(p => {
          const slabId = p.tax_slab_id != null && p.tax_slab_id !== "" ? Number(p.tax_slab_id) : null;
          const slab = (slabId != null && !Number.isNaN(slabId))
            ? (slabById[slabId] || taxSlabs.find(t => Number(t.id) === slabId))
            : null;
          return {
            ...p,
            tax_slab_id: slabId,
            tax_name: slab ? (slab.name || (Number(slab.percentage) + "%")) : null,
            tax_percentage: slab ? (Number(slab.percentage) || 0) : (Number(p.tax_percentage) || 0),
            has_variants: !!(counts[p.id]),
            variant_count: counts[p.id] || 0,
            variant_stock: variantStock[p.id] || 0,
            sell_by_weight: tsIsWeightUnit(p.unit),
          };
        }),
      };
    }
    if (method === "POST" && parts.length === 1) {
      const priced = await tsResolveProductPrice(body);
      const id = await tsAdd("products", {
        name: body.name || "Product", brand: body.brand || "", store_type: body.storeType || body.store_type || "other",
        category: body.category || "", unit: body.unit || "pcs", price: priced.price,
        price_includes_tax: priced.price_includes_tax || 0,
        inclusive_mrp: priced.inclusive_mrp || null,
        cost_price: Number(body.costPrice ?? body.cost_price) || 0, stock: Number(body.stock) || 0,
        low_stock_limit: body.lowStockLimit != null ? Number(body.lowStockLimit) : (body.low_stock_limit != null ? Number(body.low_stock_limit) : null),
        tax_slab_id: (body.taxSlabId || body.tax_slab_id) ? Number(body.taxSlabId || body.tax_slab_id) : null, sku: body.sku || "", barcode: body.barcode || "",
        hsn_code: body.hsnCode || body.hsn_code || "", notes: body.notes || "",
        expiry_date: body.expiryDate || body.expiry_date || "",
        photo_path: body.photo_path || body.photo || null,
        color: body.color || "", created_at: tsNowIso(), updated_at: tsNowIso(),
      });
      tsNotify("products"); return { ok: true, id, price: priced.price };
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
      if (method === "GET") {
        const row = await tsGet("products", id);
        if (!row) return { ok: false, error: "Not found." };
        const variants = (await tsGetAll("product_variants")).filter(v => v.product_id === id);
        return { ok: true, product: { ...row, has_variants: variants.length > 0, sell_by_weight: tsIsWeightUnit(row.unit) }, variants };
      }
      if (method === "PUT") {
        const row = await tsGet("products", id); if (!row) return { ok: false, error: "Not found." };
        let resolvedPrice;
        if (body.price != null) {
          const priced = await tsResolveProductPrice({
            ...body,
            taxSlabId: body.taxSlabId ?? body.tax_slab_id ?? row.tax_slab_id,
          });
          resolvedPrice = priced.price;
          row.price_includes_tax = priced.price_includes_tax || 0;
          if (priced.inclusive_mrp != null) row.inclusive_mrp = priced.inclusive_mrp;
        }
        const map = { name: body.name, brand: body.brand, category: body.category, unit: body.unit,
          price: resolvedPrice,
          cost_price: body.costPrice != null ? Number(body.costPrice) : (body.cost_price != null ? Number(body.cost_price) : undefined),
          stock: body.stock != null ? Number(body.stock) : undefined,
          low_stock_limit: body.lowStockLimit !== undefined ? (body.lowStockLimit === "" || body.lowStockLimit == null ? null : Number(body.lowStockLimit)) : body.low_stock_limit,
          tax_slab_id: body.taxSlabId !== undefined || body.tax_slab_id !== undefined
            ? ((body.taxSlabId ?? body.tax_slab_id) === "" || (body.taxSlabId ?? body.tax_slab_id) == null ? null : Number(body.taxSlabId ?? body.tax_slab_id))
            : undefined, sku: body.sku, barcode: body.barcode,
          hsn_code: body.hsnCode ?? body.hsn_code, notes: body.notes, color: body.color, store_type: body.storeType ?? body.store_type,
          expiry_date: body.expiryDate !== undefined ? (body.expiryDate || "") : (body.expiry_date !== undefined ? (body.expiry_date || "") : undefined),
          photo_path: body.photo_path !== undefined ? body.photo_path : (body.photo !== undefined ? body.photo : undefined) };
        for (const [k, v] of Object.entries(map)) if (v !== undefined) row[k] = v;
        if (body.pRemovePhoto || body.removePhoto) row.photo_path = null;
        row.updated_at = tsNowIso(); await tsPut("products", row); tsNotify("products"); return { ok: true };
      }
      if (method === "DELETE") {
        const id = parseInt(parts[1], 10);
        // Cascade remove variants + batches for this product
        const variants = (await tsGetAll("product_variants")).filter(v => v.product_id === id);
        for (const v of variants) await tsDelete("product_variants", v.id);
        const batches = (await tsGetAll("product_batches")).filter(b => b.product_id === id);
        for (const b of batches) await tsDelete("product_batches", b.id);
        await tsDelete("products", id); tsNotify("products"); return { ok: true };
      }
    }
    // Nested: /products/:id/variants
    if (parts.length === 3 && parts[2] === "variants") {
      const productId = parseInt(parts[1], 10);
      if (method === "GET") {
        const variants = (await tsGetAll("product_variants")).filter(v => v.product_id === productId);
        return { ok: true, variants };
      }
      if (method === "POST") {
        const parent = await tsGet("products", productId);
        if (!parent) return { ok: false, error: "Product not found." };
        const stock = Number(body.stock) || 0;
        const id = await tsAdd("product_variants", {
          product_id: productId,
          name: (body.name || "").trim() || "Variant",
          sku: body.sku || "",
          barcode: body.barcode || "",
          price: body.price != null && body.price !== "" ? Number(body.price) : null,
          cost_price: body.costPrice != null && body.costPrice !== "" ? Number(body.costPrice) : (body.cost_price != null ? Number(body.cost_price) : null),
          stock,
          created_at: tsNowIso(),
        });
        // Adding variant stock also bumps parent so inventory stays consistent
        if (stock) await tsAdjustStock(productId, stock, "Variant added: " + (body.name || id), "variant", id);
        tsNotify("products"); tsNotify("variants");
        return { ok: true, id };
      }
    }
    // Nested: /products/:id/batches
    if (parts.length === 3 && parts[2] === "batches") {
      const productId = parseInt(parts[1], 10);
      if (method === "GET") {
        const batches = (await tsGetAll("product_batches")).filter(b => b.product_id === productId);
        return { ok: true, batches };
      }
      if (method === "POST") {
        const parent = await tsGet("products", productId);
        if (!parent) return { ok: false, error: "Product not found." };
        const qty = Number(body.qty) || 0;
        const id = await tsAdd("product_batches", {
          product_id: productId,
          variant_id: body.variantId || body.variant_id || null,
          batch_number: (body.batchNumber || body.batch_number || "").trim() || ("B-" + Date.now()),
          qty,
          expiry_date: body.expiryDate || body.expiry_date || "",
          manufactured_date: body.manufacturedDate || body.manufactured_date || "",
          notes: body.notes || "",
          created_at: tsNowIso(),
        });
        if (qty) await tsAdjustStock(productId, qty, "Batch " + (body.batchNumber || id), "batch", id);
        tsNotify("products"); tsNotify("batches");
        return { ok: true, id };
      }
    }
  }

  // ---- Inventory (manual adjust + movement log) ----
  if (parts[0] === "inventory") {
    if (parts[1] === "movements" && method === "GET") {
      const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 200);
      const all = (await tsGetAll("inventory_movements")).sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, limit);
      return { ok: true, movements: all };
    }
    if (parts[1] === "adjust" && method === "POST") {
      const productId = parseInt(body.productId ?? body.product_id, 10);
      const variantId = body.variantId != null || body.variant_id != null
        ? parseInt(body.variantId ?? body.variant_id, 10) : null;
      const delta = Number(body.delta);
      if ((!productId && !variantId) || Number.isNaN(delta)) return { ok: false, error: "Product and delta required." };
      const reason = (body.reason || "Manual adjust").trim();
      let stock = null;
      if (variantId) {
        stock = await tsAdjustVariantStock(variantId, delta, reason, "manual", null, { allowNegative: true });
        if (stock === null) return { ok: false, error: "Variant not found." };
      } else {
        stock = await tsAdjustStock(productId, delta, reason, "manual", null);
        if (stock === null) return { ok: false, error: "Product not found." };
      }
      tsNotify("products"); tsNotify("inventory");
      return { ok: true, stock, variantId: variantId || null };
    }
  }

  // ---- Top-level variant / batch delete ----
  if (parts[0] === "variants" && parts.length === 2) {
    const id = parseInt(parts[1], 10);
    if (method === "DELETE") {
      const v = await tsGet("product_variants", id);
      if (!v) return { ok: false, error: "Not found." };
      // Reverse variant stock off the parent before delete
      if (v.product_id && (Number(v.stock) || 0)) {
        await tsAdjustStock(v.product_id, -(Number(v.stock) || 0), "Variant deleted: " + (v.name || id), "variant", id);
      }
      await tsDelete("product_variants", id);
      tsNotify("products"); tsNotify("variants");
      return { ok: true };
    }
    if (method === "PUT") {
      const v = await tsGet("product_variants", id);
      if (!v) return { ok: false, error: "Not found." };
      const oldStock = Number(v.stock) || 0;
      if (body.name != null) v.name = body.name;
      if (body.sku != null) v.sku = body.sku;
      if (body.barcode != null) v.barcode = body.barcode;
      if (body.price != null && body.price !== "") v.price = Number(body.price);
      if (body.costPrice != null || body.cost_price != null) v.cost_price = Number(body.costPrice ?? body.cost_price);
      if (body.stock != null) {
        const newStock = Number(body.stock) || 0;
        const diff = newStock - oldStock;
        v.stock = newStock;
        if (diff && v.product_id) await tsAdjustStock(v.product_id, diff, "Variant stock edit: " + (v.name || id), "variant", id);
      }
      await tsPut("product_variants", v);
      tsNotify("products"); tsNotify("variants");
      return { ok: true };
    }
  }

  if (parts[0] === "batches" && parts.length === 2 && method === "DELETE") {
    const id = parseInt(parts[1], 10);
    const b = await tsGet("product_batches", id);
    if (!b) return { ok: false, error: "Not found." };
    // Reverse batch qty from product stock
    if (b.product_id && (Number(b.qty) || 0)) {
      await tsAdjustStock(b.product_id, -(Number(b.qty) || 0), "Batch deleted: " + (b.batch_number || id), "batch", id);
    }
    await tsDelete("product_batches", id);
    tsNotify("products"); tsNotify("batches");
    return { ok: true };
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
        const invoices = (await tsGetAll("invoices")).filter(i => i.client_id === id)
          .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
        let totalBilled = 0, totalPaid = 0, outstanding = 0;
        for (const i of invoices) {
          const tot = Number(i.total) || 0;
          const st = String(i.status || "").toLowerCase();
          // amount_paid may be missing on older paid invoices — treat paid as fully paid
          let ap = Number(i.amount_paid);
          if (!Number.isFinite(ap) || ap < 0) ap = 0;
          if (st === "paid" && ap <= 0) ap = tot;
          totalBilled += tot;
          totalPaid += Math.min(ap, tot);
          if (st !== "paid") outstanding += Math.max(0, tot - ap);
        }
        return {
          ok: true, client, invoices,
          summary: {
            totalBilled: Math.round(totalBilled * 100) / 100,
            totalInvoiced: Math.round(totalBilled * 100) / 100,
            totalPaid: Math.round(totalPaid * 100) / 100,
            outstanding: Math.round(outstanding * 100) / 100,
            totalUnpaid: Math.round(outstanding * 100) / 100,
            creditBalance: Number(client.credit_balance) || 0,
          },
        };
      }
      if (parts[2] === "prices" && method === "GET") {
        const client = await tsGet("clients", id);
        if (!client) return { ok: false, error: "Not found." };
        const prices = {};
        const listId = client.price_list_id != null ? parseInt(client.price_list_id, 10) : null;
        if (listId) {
          const items = await tsGetAll("price_list_items");
          for (const it of items) {
            if (Number(it.price_list_id) === listId && it.product_id != null) {
              prices[String(it.product_id)] = Number(it.price);
            }
          }
        }
        return { ok: true, prices, priceListId: listId || null };
      }
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
      // Block sales that would drive stock negative
      const stockCheck = await tsCheckStockAvailable(items);
      if (!stockCheck.ok) return stockCheck;
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
        items: items.map(it => ({
          product_id: it.productId ?? it.product_id ?? null,
          variant_id: it.variantId ?? it.variant_id ?? null,
          name: it.name || "",
          qty: Number(it.qty) || 1,
          price: Number(it.price) || 0,
          tax_percent: Number(it.taxPercent ?? it.tax_percent) || 0,
          unit: it.unit || "",
        })),
        created_at: tsNowIso() };
      const invoice_id = await tsAdd("invoices", inv);
      for (const it of inv.items) {
        if (it.variant_id) {
          // Variant-aware deduct: adjusts variant + parent stock
          await tsAdjustVariantStock(it.variant_id, -Number(it.qty) || 0, "Sale " + invoice_number, "invoice", invoice_id);
        } else if (it.product_id) {
          await tsAdjustStock(it.product_id, -Number(it.qty) || 0, "Sale " + invoice_number, "invoice", invoice_id);
        }
      }
      for (const p of payments) {
        const amt = Number(p.amount) || 0; if (amt <= 0) continue;
        await tsAdd("payments", { invoice_id, amount: amt, method: (p.method || "cash").toLowerCase(), reference: p.reference || "", notes: p.notes || "", created_at: tsNowIso() });
      }
      // Overpayment surplus -> store credit on client account
      const paidSum = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) || Number(body.amountPaid) || 0;
      const surplus = Math.round((paidSum - totals.total) * 100) / 100;
      if (surplus > 0.009 && client_id) {
        const cl = await tsGet("clients", client_id);
        if (cl) {
          cl.credit_balance = (Number(cl.credit_balance) || 0) + surplus;
          await tsPut("clients", cl);
          await tsAdd("credit_transactions", {
            client_id, amount: surplus,
            reason: "Overpayment surplus on " + invoice_number,
            balance_after: cl.credit_balance, created_at: tsNowIso(),
          });
          tsNotify("clients");
        }
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
      const prevPaid = Number(inv.amount_paid) || 0;
      const prevStatus = inv.status;
      inv.status = body.status || inv.status;
      if (inv.status === "paid") {
        inv.amount_paid = inv.total;
        // When marking paid from notifications/admin, optionally record the remaining as a payment
        // so cash box / UPI totals stay in sync with real money received.
        const method = String(body.method || body.payMethod || "cash").toLowerCase();
        const delta = Math.max(0, (Number(inv.total) || 0) - prevPaid);
        if (delta > 0.009 && prevStatus !== "paid") {
          await tsAdd("payments", {
            invoice_id: inv.id, amount: delta, method,
            reference: body.reference || "", notes: body.notes || "Marked paid", created_at: tsNowIso(),
          });
          const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
          if (shift) {
            if (method === "cash") shift.cash_sales = (Number(shift.cash_sales) || 0) + delta;
            else if (method === "card") shift.card_sales = (Number(shift.card_sales) || 0) + delta;
            else if (method === "upi") shift.upi_sales = (Number(shift.upi_sales) || 0) + delta;
            else shift.other_sales = (Number(shift.other_sales) || 0) + delta;
            await tsPut("cash_shifts", shift);
            tsNotify("shifts");
          }
          await tsAdd("cash_ledger", {
            type: "sale_payment", amount: delta, method, ref_type: "invoice", ref_id: inv.id,
            notes: "Invoice " + (inv.invoice_number || inv.id) + " marked paid", created_at: tsNowIso(),
          });
        }
      } else if (body.amountPaid != null || body.amount_paid != null) {
        inv.amount_paid = Number(body.amountPaid ?? body.amount_paid) || 0;
      }
      if (body.dueDate !== undefined || body.due_date !== undefined) {
        inv.due_date = body.dueDate ?? body.due_date ?? "";
      }
      if (body.notes !== undefined) inv.notes = body.notes;
      await tsPut("invoices", inv); tsNotify("invoices"); return { ok: true, invoice: inv };
    }
    if (parts.length === 3 && parts[2] === "write-off" && method === "POST") {
      const inv = await tsGet("invoices", parseInt(parts[1], 10)); if (!inv) return { ok: false, error: "Not found." };
      inv.status = "paid";
      inv.amount_paid = inv.total;
      inv.notes = ((inv.notes || "") + " | Written off").replace(/^ \| /, "");
      await tsPut("invoices", inv);
      tsNotify("invoices");
      return { ok: true, invoice: inv };
    }
    if (parts.length === 3 && parts[2] === "pay" && method === "POST") {
      const inv = await tsGet("invoices", parseInt(parts[1], 10)); if (!inv) return { ok: false, error: "Not found." };
      const amt = Number(body.amount) || 0;
      if (amt <= 0) return { ok: false, error: "Amount required." };
      const paid = (Number(inv.amount_paid) || 0) + amt;
      inv.amount_paid = Math.min(paid, Number(inv.total) || 0);
      if (inv.amount_paid + 0.001 >= Number(inv.total)) { inv.status = "paid"; inv.amount_paid = inv.total; }
      else inv.status = "partial";
      const payMethod = (body.method || "cash").toLowerCase();
      await tsAdd("payments", {
        invoice_id: inv.id, amount: amt, method: payMethod,
        reference: body.reference || "", notes: body.notes || "Notification payment", created_at: tsNowIso(),
      });
      // Sync open cash shift + cash ledger so day-end and cash box stay correct
      const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
      if (shift) {
        if (payMethod === "cash") shift.cash_sales = (Number(shift.cash_sales) || 0) + amt;
        else if (payMethod === "card") shift.card_sales = (Number(shift.card_sales) || 0) + amt;
        else if (payMethod === "upi") shift.upi_sales = (Number(shift.upi_sales) || 0) + amt;
        else shift.other_sales = (Number(shift.other_sales) || 0) + amt;
        await tsPut("cash_shifts", shift);
        tsNotify("shifts");
      }
      await tsAdd("cash_ledger", {
        type: "sale_payment", amount: amt, method: payMethod, ref_type: "invoice", ref_id: inv.id,
        notes: "Payment on " + (inv.invoice_number || inv.id), created_at: tsNowIso(),
      });
      await tsPut("invoices", inv);
      tsNotify("invoices");
      return { ok: true, invoice: inv };
    }
    if (parts.length === 2 && method === "DELETE") {
      const id = parseInt(parts[1], 10); const inv = await tsGet("invoices", id);
      if (inv && inv.items) {
        for (const it of inv.items) {
          if (it.variant_id) await tsAdjustVariantStock(it.variant_id, Number(it.qty) || 0, "Invoice deleted", "invoice", id);
          else if (it.product_id) await tsAdjustStock(it.product_id, Number(it.qty) || 0, "Invoice deleted", "invoice", id);
        }
      }
      await tsDelete("invoices", id); tsNotify("invoices"); return { ok: true };
    }
    if (parts.length === 3 && parts[2] === "share" && method === "POST") return { ok: true, token: "local-" + parts[1], url: "#local-share-" + parts[1] };
  }

  if (parts[0] === "branding") {
    if (method === "GET") return { ok: true, branding: await tsGetAllSettings() };
    if (method === "POST") {
      // Map upload field name from admin form (brandLogo data URL) to the key the UI expects
      if (body.brandLogo && typeof body.brandLogo === "string" && body.brandLogo.startsWith("data:")) {
        body.custom_brand_logo = body.brandLogo;
      }
      for (const [k, v] of Object.entries(body)) {
        if (k === "ok" || k === "brandLogo" || k === "brandLogo_name") continue;
        // Keep data URLs intact (do not truncate); everything else as string
        await tsSetSetting(k, v == null ? "" : (typeof v === "string" ? v : String(v)));
      }
      tsNotify("branding"); return { ok: true };
    }
  }

  if (parts[0] === "invoice-layouts") {
    if (method === "GET") return { ok: true, layouts: (await tsGetAll("invoice_layouts")).map(L => ({ ...L, paper_size: L.paper_size || "a4", elements: JSON.parse(L.elements_json || "[]") })) };
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("invoice_layouts", {
        name: body.name || "Custom", is_preset: 0,
        paper_size: body.paperSize || body.paper_size || "a4",
        elements_json: JSON.stringify(body.elements || []),
        created_at: tsNowIso(),
      });
      return { ok: true, id };
    }
    if (parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (method === "PUT") {
        const row = await tsGet("invoice_layouts", id); if (!row) return { ok: false, error: "Not found." };
        if (body.name != null) row.name = body.name;
        if (body.elements) row.elements_json = JSON.stringify(body.elements);
        if (body.paperSize != null || body.paper_size != null) row.paper_size = body.paperSize || body.paper_size;
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
      // If no float passed, seed from admin cash opening balance setting
      let openingFloat = Number(body.openingFloat ?? body.opening_float);
      if (!openingFloat && openingFloat !== 0) openingFloat = Number(await tsGetSetting("cash_opening_balance", "0")) || 0;
      if (body.openingFloat == null && body.opening_float == null) {
        openingFloat = Number(await tsGetSetting("cash_opening_balance", "0")) || 0;
      } else {
        openingFloat = Number(body.openingFloat ?? body.opening_float) || 0;
      }
      const id = await tsAdd("cash_shifts", { user_email: who.email || "", user_name: who.name || "", opened_at: tsNowIso(), closed_at: null,
        opening_float: openingFloat, closing_cash: null, expected_cash: null, cash_sales: 0, card_sales: 0, upi_sales: 0, other_sales: 0, variance: null, notes: "", status: "open" });
      tsNotify("shifts"); tsNotify("cashbox"); return { ok: true, id, openingFloat };
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
    if (method === "GET") {
      const rows = await tsGetAll("returns");
      rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      return { ok: true, returns: rows };
    }
    if (method === "POST") {
      const items = (body.items || []).map(it => ({
        productId: it.productId ?? it.product_id ?? null,
        variantId: it.variantId ?? it.variant_id ?? null,
        name: it.name || "",
        qty: Number(it.qty) || 0,
        price: Number(it.price) || 0,
      }));
      const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
      const return_number = body.returnNumber || ("RET-" + Date.now());
      const restock = !!(body.restock);
      const creditToClient = !!(body.creditToClient ?? body.credit_to_client);
      const refundMethod = String(body.refundMethod || body.method || "cash").toLowerCase();
      const id = await tsAdd("returns", {
        return_number,
        invoice_id: body.invoiceId ?? body.invoice_id ?? null,
        client_id: body.clientId ?? body.client_id ?? null,
        client_name: body.clientName || body.client_name || "",
        total, restock: restock ? 1 : 0, credit_to_client: creditToClient ? 1 : 0,
        refund_method: refundMethod,
        notes: body.notes || "",
        items, created_at: tsNowIso(),
      });
      // Restock: variant-aware + parent product
      if (restock) {
        for (const it of items) {
          const qty = Number(it.qty) || 0;
          if (qty <= 0) continue;
          if (it.variantId) {
            await tsAdjustVariantStock(it.variantId, qty, "Return " + return_number, "return", id, { allowNegative: true });
          } else if (it.productId) {
            await tsAdjustStock(it.productId, qty, "Return " + return_number, "return", id, { allowNegative: true });
          }
        }
        tsNotify("products");
        tsNotify("inventory");
      }
      // Store credit to client
      const clientId = body.clientId ?? body.client_id ?? null;
      if (creditToClient && clientId) {
        const client = await tsGet("clients", clientId);
        if (client) {
          client.credit_balance = (Number(client.credit_balance) || 0) + total;
          await tsPut("clients", client);
          await tsAdd("credit_transactions", {
            client_id: clientId, amount: total, reason: "Return " + return_number,
            balance_after: client.credit_balance, created_at: tsNowIso(),
          });
          tsNotify("clients");
        }
      } else if (total > 0 && !creditToClient) {
        // Cash/UPI/card refund out of drawer — reduce open shift totals
        const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
        if (shift) {
          if (refundMethod === "cash") shift.cash_sales = (Number(shift.cash_sales) || 0) - total;
          else if (refundMethod === "upi") shift.upi_sales = (Number(shift.upi_sales) || 0) - total;
          else if (refundMethod === "card") shift.card_sales = (Number(shift.card_sales) || 0) - total;
          else shift.other_sales = (Number(shift.other_sales) || 0) - total;
          await tsPut("cash_shifts", shift);
          tsNotify("shifts");
        }
        await tsAdd("cash_ledger", {
          type: "return_refund", amount: -total, method: refundMethod,
          ref_type: "return", ref_id: id,
          notes: "Refund " + return_number, created_at: tsNowIso(),
        });
        tsNotify("cashbox");
      }
      tsNotify("returns");
      return { ok: true, id, returnNumber: return_number, total };
    }
    if (parts.length === 2 && method === "DELETE") {
      const id = parseInt(parts[1], 10);
      const row = await tsGet("returns", id);
      if (row) {
        // Reverse restock if it was restocked
        if (row.restock && row.items) {
          for (const it of row.items) {
            const qty = Number(it.qty) || 0;
            const pid = it.productId ?? it.product_id;
            const vid = it.variantId ?? it.variant_id;
            if (vid) await tsAdjustVariantStock(vid, -qty, "Return deleted", "return", id);
            else if (pid) await tsAdjustStock(pid, -qty, "Return deleted", "return", id);
          }
        }
        await tsDelete("returns", id);
        tsNotify("returns"); tsNotify("products");
      }
      return { ok: true };
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
    if (method === "GET" && parts.length === 1) {
      const lists = await tsGetAll("price_lists");
      const items = await tsGetAll("price_list_items");
      const clients = await tsGetAll("clients");
      return {
        ok: true,
        priceLists: lists.map(l => ({
          ...l,
          items: items.filter(i => Number(i.price_list_id) === Number(l.id)),
          clientCount: clients.filter(c => Number(c.price_list_id) === Number(l.id)).length,
          clients: clients.filter(c => Number(c.price_list_id) === Number(l.id)).map(c => ({ id: c.id, name: c.name })),
        })),
      };
    }
    if (method === "POST" && parts.length === 1) {
      const id = await tsAdd("price_lists", { name: body.name || "List", notes: body.notes || "", created_at: tsNowIso() });
      tsNotify("price_lists");
      return { ok: true, id };
    }
    if (parts.length === 2 && method === "GET") {
      const lid = parseInt(parts[1], 10);
      const list = await tsGet("price_lists", lid);
      if (!list) return { ok: false, error: "Not found." };
      const items = (await tsGetAll("price_list_items")).filter(i => Number(i.price_list_id) === lid);
      const clients = (await tsGetAll("clients")).filter(c => Number(c.price_list_id) === lid);
      return { ok: true, priceList: { ...list, items, clients } };
    }
    if (parts.length === 2 && method === "PUT") {
      const lid = parseInt(parts[1], 10);
      const list = await tsGet("price_lists", lid);
      if (!list) return { ok: false, error: "Not found." };
      if (body.name != null) list.name = body.name;
      if (body.notes != null) list.notes = body.notes;
      await tsPut("price_lists", list);
      if (Array.isArray(body.items)) {
        const existing = (await tsGetAll("price_list_items")).filter(i => Number(i.price_list_id) === lid);
        for (const e of existing) await tsDelete("price_list_items", e.id);
        for (const it of body.items) {
          if (it.productId == null && it.product_id == null) continue;
          await tsAdd("price_list_items", {
            price_list_id: lid,
            product_id: it.productId ?? it.product_id,
            price: Number(it.price) || 0,
          });
        }
      }
      tsNotify("price_lists");
      return { ok: true };
    }
    if (parts.length === 2 && method === "DELETE") {
      const lid = parseInt(parts[1], 10);
      const existing = (await tsGetAll("price_list_items")).filter(i => Number(i.price_list_id) === lid);
      for (const e of existing) await tsDelete("price_list_items", e.id);
      const clients = await tsGetAll("clients");
      for (const c of clients) {
        if (Number(c.price_list_id) === lid) {
          c.price_list_id = null;
          await tsPut("clients", c);
        }
      }
      await tsDelete("price_lists", lid);
      tsNotify("price_lists");
      return { ok: true };
    }
    if (parts.length === 3 && parts[2] === "assign" && method === "POST") {
      const lid = parseInt(parts[1], 10);
      const list = await tsGet("price_lists", lid);
      if (!list) return { ok: false, error: "List not found." };
      const clientIds = body.clientIds || body.client_ids || (body.clientId != null ? [body.clientId] : []);
      let n = 0;
      for (const cid of clientIds) {
        const c = await tsGet("clients", parseInt(cid, 10));
        if (!c) continue;
        c.price_list_id = lid;
        await tsPut("clients", c);
        n++;
      }
      tsNotify("clients");
      return { ok: true, assigned: n };
    }
    if (parts.length === 3 && parts[2] === "unassign" && method === "POST") {
      const clientIds = body.clientIds || body.client_ids || (body.clientId != null ? [body.clientId] : []);
      let n = 0;
      for (const cid of clientIds) {
        const c = await tsGet("clients", parseInt(cid, 10));
        if (!c) continue;
        c.price_list_id = null;
        await tsPut("clients", c);
        n++;
      }
      tsNotify("clients");
      return { ok: true, unassigned: n };
    }
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
      const products = await tsGetAll("products");
      const variants = await tsGetAll("product_variants");
      const invoices = await tsGetAll("invoices");
      const sold = {}; // product_id -> { qty, revenue }
      const soldVariant = {}; // variant_id -> { qty, revenue, product_id }
      for (const inv of invoices) {
        if (new Date(inv.created_at || 0).getTime() < cutoff) continue;
        for (const it of inv.items || []) {
          const qty = Number(it.qty) || 0;
          const rev = qty * (Number(it.price) || 0);
          const pid = it.product_id;
          const vid = it.variant_id;
          if (vid) {
            if (!soldVariant[vid]) soldVariant[vid] = { qty: 0, revenue: 0, product_id: pid };
            soldVariant[vid].qty += qty;
            soldVariant[vid].revenue += rev;
          }
          if (pid) {
            if (!sold[pid]) sold[pid] = { qty: 0, revenue: 0 };
            sold[pid].qty += qty;
            sold[pid].revenue += rev;
          }
        }
      }
      const variantsByProduct = {};
      for (const v of variants) {
        if (!variantsByProduct[v.product_id]) variantsByProduct[v.product_id] = [];
        variantsByProduct[v.product_id].push(v);
      }
      let total_rev = 0, total_cost = 0;
      const out = [];
      for (const p of products) {
        const s = sold[p.id] || { qty: 0, revenue: 0 };
        const pVars = variantsByProduct[p.id] || [];
        let cost = 0;
        if (pVars.length) {
          // Prefer variant cost when line items have variant_id; fall back to parent cost
          for (const v of pVars) {
            const vs = soldVariant[v.id];
            if (!vs) continue;
            const costU = (v.cost_price != null && v.cost_price !== "") ? Number(v.cost_price) : (Number(p.cost_price) || 0);
            cost += costU * vs.qty;
          }
          // Any parent-only sales (no variant) use parent cost
          let variantQty = 0;
          for (const v of pVars) variantQty += (soldVariant[v.id] ? soldVariant[v.id].qty : 0);
          const parentOnlyQty = Math.max(0, s.qty - variantQty);
          cost += (Number(p.cost_price) || 0) * parentOnlyQty;
        } else {
          cost = (Number(p.cost_price) || 0) * s.qty;
        }
        const margin = s.revenue - cost;
        total_rev += s.revenue; total_cost += cost;
        const variantStock = pVars.reduce((a, v) => a + (Number(v.stock) || 0), 0);
        out.push({
          productId: p.id, name: p.name, sku: p.sku, price: p.price,
          costPrice: Number(p.cost_price) || 0, stock: p.stock,
          variantCount: pVars.length, variantStock,
          soldQty: Math.round(s.qty * 1000) / 1000,
          revenue: Math.round(s.revenue * 100) / 100,
          cost: Math.round(cost * 100) / 100,
          margin: Math.round(margin * 100) / 100,
          marginPct: s.revenue ? Math.round((margin / s.revenue) * 1000) / 10 : null,
          variants: pVars.map(v => {
            const vs = soldVariant[v.id] || { qty: 0, revenue: 0 };
            const costU = (v.cost_price != null && v.cost_price !== "") ? Number(v.cost_price) : (Number(p.cost_price) || 0);
            const vCost = costU * vs.qty;
            const vMargin = vs.revenue - vCost;
            return {
              id: v.id, name: v.name, sku: v.sku, barcode: v.barcode,
              price: v.price != null ? v.price : p.price,
              costPrice: costU, stock: v.stock,
              soldQty: Math.round(vs.qty * 1000) / 1000,
              revenue: Math.round(vs.revenue * 100) / 100,
              cost: Math.round(vCost * 100) / 100,
              margin: Math.round(vMargin * 100) / 100,
              marginPct: vs.revenue ? Math.round((vMargin / vs.revenue) * 1000) / 10 : null,
            };
          }),
        });
      }
      out.sort((a, b) => b.margin - a.margin);
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
    const fromBatches = batches
      .filter(b => b.expiry_date && new Date(b.expiry_date).getTime() <= limit)
      .map(b => ({ ...b, product_name: pname[b.product_id] || "" }));
    // Also include product-level expiry_date
    const fromProducts = products
      .filter(p => p.expiry_date && new Date(p.expiry_date).getTime() <= limit)
      .map(p => ({
        id: "p-" + p.id, product_id: p.id, product_name: p.name,
        batch_number: "(product)", qty: p.stock, expiry_date: p.expiry_date, notes: "Product expiry",
      }));
    // de-dupe by product+date roughly
    const all = [...fromBatches, ...fromProducts];
    all.sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
    return { ok: true, batches: all };
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
  if (parts[0] === "sessions") {
    const current = tsGetSession();
    const deviceId = tsDeviceId();
    // Ensure store exists for older DBs
    try {
      const db = await tsOpenDB();
      if (!db.objectStoreNames.contains("auth_sessions")) {
        // can't create outside versionchange — fall through to ephemeral
      }
    } catch (e) {}

    if (method === "GET" && parts.length === 1) {
      let rows = [];
      try { rows = await tsGetAll("auth_sessions"); } catch (e) { rows = []; }
      // Always include current browser session even if log empty
      if (current && current.email) {
        const hasCur = rows.some(r => r.device_id === deviceId && !r.revoked);
        if (!hasCur) {
          rows.push({
            id: "current",
            email: current.email,
            role: current.role,
            user_agent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
            ip_address: "local",
            device_id: deviceId,
            created_at: new Date(current.signedInAt || Date.now()).toISOString(),
            last_active_at: new Date().toISOString(),
            expires_at: "",
            revoked: 0,
          });
        }
      }
      // relative last-active + is_current
      const now = Date.now();
      const out = rows
        .filter(r => !r.revoked)
        .map(r => {
          const last = new Date(r.last_active_at || r.created_at || now).getTime();
          const mins = Math.max(0, Math.round((now - last) / 60000));
          let rel = "just now";
          if (mins >= 1 && mins < 60) rel = mins + " min ago";
          else if (mins >= 60 && mins < 1440) rel = Math.floor(mins / 60) + " h ago";
          else if (mins >= 1440) rel = Math.floor(mins / 1440) + " d ago";
          return {
            id: r.id,
            email: r.email,
            role: r.role,
            user_agent: r.user_agent || "",
            ip_address: r.ip_address || "local",
            created_at: r.created_at || "",
            last_active_at: r.last_active_at || "",
            last_active_relative: rel,
            expires_at: r.expires_at || "",
            is_current: !!(current && r.device_id === deviceId && r.email === current.email),
            device_id: r.device_id || "",
          };
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      // also return recent revoked as history under same endpoint via query?history=1
      if (query.history === "1") {
        const hist = rows
          .filter(r => r.revoked)
          .map(r => ({
            id: r.id, email: r.email, role: r.role, user_agent: r.user_agent || "",
            created_at: r.created_at || "", last_active_at: r.last_active_at || "",
            revoked: true, is_current: false,
          }))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 50);
        return { ok: true, sessions: out, history: hist };
      }
      return { ok: true, sessions: out };
    }

    // Revoke one session by id
    if (parts.length === 2 && parts[1] !== "revoke-others" && method === "POST") {
      // path /sessions/:id/revoke
    }
    if (parts.length === 3 && parts[2] === "revoke" && method === "POST") {
      const id = parts[1];
      if (id === "current") return { ok: false, error: "Cannot revoke the current session this way." };
      const row = await tsGet("auth_sessions", isNaN(Number(id)) ? id : parseInt(id, 10));
      if (!row) return { ok: false, error: "Session not found." };
      row.revoked = 1;
      row.last_active_at = new Date().toISOString();
      await tsPut("auth_sessions", row);
      tsNotify("sessions");
      return { ok: true };
    }
    if (parts[1] === "revoke-others" && method === "POST") {
      const rows = await tsGetAll("auth_sessions");
      for (const r of rows) {
        if (r.device_id !== deviceId && !r.revoked) {
          r.revoked = 1;
          r.last_active_at = new Date().toISOString();
          await tsPut("auth_sessions", r);
        }
      }
      tsNotify("sessions");
      return { ok: true };
    }
  }



  // ---- Quotations ----
  if (parts[0] === "quotations") {
    if (method === "GET" && parts.length === 1) {
      const list = (await tsGetAll("quotations")).sort((a, b) => (b.id || 0) - (a.id || 0));
      return { ok: true, quotations: list };
    }
    if (method === "POST" && parts.length === 1) {
      const items = body.items || [];
      if (!items.length) return { ok: false, error: "Add at least one line item." };
      const quote_number = (body.quoteNumber || body.quote_number || "QT-" + Date.now()).trim();
      if ((await tsGetAll("quotations")).find(q => q.quote_number === quote_number))
        return { ok: false, error: "Quote number already exists." };
      let client_id = body.clientId ?? body.client_id ?? null;
      let client_name = (body.clientName || body.client_name || "").trim();
      if (client_id && !client_name) {
        const c = await tsGet("clients", client_id);
        client_name = c ? c.name : "";
      }
      const discount = Number(body.discount) || 0;
      const totals = tsCalcInvoiceTotals(items, discount, 0);
      const id = await tsAdd("quotations", {
        quote_number, client_id, client_name,
        subtotal: totals.subtotal, discount: totals.discount, tax_amount: totals.tax_amount, total: totals.total,
        status: body.status || "draft", notes: body.notes || "", valid_until: body.validUntil || body.valid_until || "",
        items: items.map(it => ({
          product_id: it.productId ?? it.product_id ?? null,
          variant_id: it.variantId ?? it.variant_id ?? null,
          name: it.name || "",
          qty: Number(it.qty) || 1, price: Number(it.price) || 0,
          tax_percent: Number(it.taxPercent ?? it.tax_percent) || 0,
          unit: it.unit || "",
        })),
        created_at: tsNowIso(),
      });
      tsNotify("quotations");
      return { ok: true, id, quoteNumber: quote_number };
    }
    if (parts.length === 2 && method === "GET") {
      const q = await tsGet("quotations", parseInt(parts[1], 10));
      return q ? { ok: true, quotation: q } : { ok: false, error: "Not found." };
    }
    if (parts.length === 2 && method === "DELETE") {
      await tsDelete("quotations", parseInt(parts[1], 10));
      tsNotify("quotations");
      return { ok: true };
    }
    if (parts.length === 3 && parts[2] === "convert" && method === "POST") {
      const q = await tsGet("quotations", parseInt(parts[1], 10));
      if (!q) return { ok: false, error: "Not found." };
      if (q.status === "converted") return { ok: false, error: "Already converted." };
      const invoice_number = "INV-" + Date.now();
      const inv = {
        invoice_number, client_id: q.client_id, client_name: q.client_name || "",
        subtotal: q.subtotal, discount: q.discount, tax_amount: q.tax_amount, total: q.total,
        credit_applied: 0, status: "unpaid", notes: (q.notes || "") + " | From quote " + q.quote_number,
        layout_id: null, amount_paid: 0, due_date: "", items: q.items || [], created_at: tsNowIso(),
      };
      const s = await tsGetSetting("active_layout_id", "");
      if (s) inv.layout_id = parseInt(s, 10) || null;
      const invoice_id = await tsAdd("invoices", inv);
      for (const it of inv.items || []) {
        if (it.variant_id) {
          await tsAdjustVariantStock(it.variant_id, -Number(it.qty) || 0, "Sale from quote " + q.quote_number, "invoice", invoice_id);
        } else if (it.product_id) {
          await tsAdjustStock(it.product_id, -Number(it.qty) || 0, "Sale from quote " + q.quote_number, "invoice", invoice_id);
        }
      }
      q.status = "converted";
      q.converted_invoice_id = invoice_id;
      q.converted_at = tsNowIso();
      await tsPut("quotations", q);
      tsNotify("quotations");
      tsNotify("invoices");
      return { ok: true, invoiceId: invoice_id, invoiceNumber: invoice_number };
    }
  }

  // ---- Full backup / restore (IndexedDB) ----
  if (parts[0] === "backup" && method === "GET") {
    const payload = await tsBuildBackupPayload();
    return { ok: true, backup: payload };
  }
  if (parts[0] === "restore" && method === "POST") {
    const payload = body.backup || body;
    if (!payload || typeof payload !== "object") return { ok: false, error: "Invalid backup file." };
    await tsRestoreBackupPayload(payload);
    tsNotify("wipe");
    return { ok: true };
  }

  // ---- Due invoices ----
  if (parts[0] === "due-invoices" && method === "GET") {
    const today = new Date().toISOString().slice(0, 10);
    const invoices = await tsGetAll("invoices");
    const due = invoices
      .filter(i => (i.status === "unpaid" || i.status === "partial") && i.due_date)
      .map(i => {
        const outstanding = Math.max(0, (Number(i.total) || 0) - (Number(i.amount_paid) || 0));
        const overdue = i.due_date < today;
        return { ...i, outstanding, overdue, daysUntil: Math.round((new Date(i.due_date) - new Date(today)) / 86400000) };
      })
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    return { ok: true, invoices: due, today };
  }



  // ---- Analytics (charts for admin Insights) ----

  // ---- Dead stock (no sales in N days, default 60 = 2 months) ----
  if (parts[0] === "reports" && parts[1] === "deadstock" && method === "GET") {
    const days = parseInt(query.days || "60", 10);
    const cutoff = Date.now() - days * 86400000;
    const products = await tsGetAll("products");
    const invoices = await tsGetAll("invoices");
    const lastSold = {};
    for (const inv of invoices) {
      const t = new Date(inv.created_at || 0).getTime();
      for (const it of inv.items || []) {
        if (!it.product_id) continue;
        const prev = lastSold[it.product_id];
        if (prev == null || t > prev) lastSold[it.product_id] = t;
      }
    }
    const out = [];
    for (const p of products) {
      const ls = lastSold[p.id];
      if (ls != null && ls >= cutoff) continue; // sold recently
      out.push({
        id: p.id, name: p.name, sku: p.sku, category: p.category, brand: p.brand,
        stock: p.stock, price: p.price, cost_price: p.cost_price,
        expiry_date: p.expiry_date || "",
        lastSoldAt: ls ? new Date(ls).toISOString() : null,
        daysSinceSale: ls ? Math.floor((Date.now() - ls) / 86400000) : null,
        neverSold: ls == null,
      });
    }
    out.sort((a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0));
    return { ok: true, days, products: out };
  }

  // ---- Fast moving products ----
  if (parts[0] === "reports" && parts[1] === "fast-moving" && method === "GET") {
    const days = parseInt(query.days || "30", 10);
    const cutoff = Date.now() - days * 86400000;
    const products = await tsGetAll("products");
    const invoices = await tsGetAll("invoices");
    const sold = {};
    for (const inv of invoices) {
      const t = new Date(inv.created_at || 0).getTime();
      if (t < cutoff) continue;
      for (const it of inv.items || []) {
        if (!it.product_id) continue;
        if (!sold[it.product_id]) sold[it.product_id] = { qty: 0, revenue: 0 };
        sold[it.product_id].qty += Number(it.qty) || 0;
        sold[it.product_id].revenue += (Number(it.qty) || 0) * (Number(it.price) || 0);
      }
    }
    const out = [];
    for (const p of products) {
      const s = sold[p.id];
      if (!s || s.qty <= 0) continue;
      out.push({
        id: p.id, name: p.name, sku: p.sku, category: p.category,
        stock: p.stock, price: p.price, soldQty: Math.round(s.qty * 1000) / 1000,
        revenue: Math.round(s.revenue * 100) / 100,
        dailyVelocity: Math.round((s.qty / days) * 1000) / 1000,
      });
    }
    out.sort((a, b) => b.soldQty - a.soldQty);
    return { ok: true, days, products: out };
  }

  if (parts[0] === "analytics" && method === "GET") {
    const days = parseInt(query.days || "30", 10);
    const cutoff = Date.now() - days * 86400000;
    const invoices = await tsGetAll("invoices");
    const products = await tsGetAll("products");
    const clients = await tsGetAll("clients");
    const byDay = {};
    const productSales = {};
    const clientSales = {};
    for (const inv of invoices) {
      const t = new Date(inv.created_at || 0).getTime();
      if (t < cutoff) continue;
      const day = String(inv.created_at || "").slice(0, 10) || "unknown";
      byDay[day] = (byDay[day] || 0) + (Number(inv.total) || 0);
      const cname = inv.client_name || "Walk-in";
      clientSales[cname] = (clientSales[cname] || 0) + (Number(inv.total) || 0);
      for (const it of inv.items || []) {
        const n = it.name || "Item";
        if (!productSales[n]) productSales[n] = { qty: 0, revenue: 0 };
        productSales[n].qty += Number(it.qty) || 0;
        productSales[n].revenue += (Number(it.qty) || 0) * (Number(it.price) || 0);
      }
    }
    const revenueLabels = Object.keys(byDay).sort();
    const revenueData = revenueLabels.map(k => Math.round(byDay[k] * 100) / 100);
    const topProducts = Object.entries(productSales)
      .map(([name, v]) => ({ name, qty: v.qty, revenue: Math.round(v.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue).slice(0, 8);
    const topClients = Object.entries(clientSales)
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total).slice(0, 8);
    const defaultLimit = parseInt((await tsGetSetting("default_low_stock_limit", "5")) || "5", 10);
    const lowStock = products
      .filter(p => (Number(p.stock) || 0) <= (p.low_stock_limit != null ? p.low_stock_limit : defaultLimit))
      .sort((a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0))
      .slice(0, 30);
    return {
      ok: true, days,
      revenue: { labels: revenueLabels, data: revenueData },
      topProducts, topClients, lowStock,
      productLabels: topProducts.map(p => p.name),
      productData: topProducts.map(p => p.revenue),
      clientLabels: topClients.map(c => c.name),
      clientData: topClients.map(c => c.total),
    };
  }

  // ---- Admin notifications (Pay Later + overdue) ----
  if (parts[0] === "notifications" && method === "GET") {
    const today = new Date().toISOString().slice(0, 10);
    const invoices = await tsGetAll("invoices");
    const items = [];
    for (const i of invoices) {
      const st = (i.status || "").toLowerCase();
      if (st !== "unpaid" && st !== "partial") continue;
      const outstanding = Math.max(0, (Number(i.total) || 0) - (Number(i.amount_paid) || 0));
      if (outstanding <= 0) continue;
      const notes = String(i.notes || "");
      const isPayLater = /pay\s*later/i.test(notes) || !!(i.due_date);
      const overdue = i.due_date && i.due_date < today;
      items.push({
        id: i.id,
        type: isPayLater ? "pay_later" : "unpaid",
        invoice_number: i.invoice_number,
        client_name: i.client_name || "Walk-in",
        client_id: i.client_id,
        total: i.total,
        amount_paid: i.amount_paid || 0,
        outstanding,
        status: i.status,
        due_date: i.due_date || "",
        notes,
        created_at: i.created_at,
        overdue: !!overdue,
      });
    }
    items.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    return { ok: true, notifications: items, count: items.length };
  }


  // ---- GST compliance reports (Indian) for accountant dashboard ----
  if (parts[0] === "gst" && method === "GET") {
    const from = (query.from || "").slice(0, 10);
    const to = (query.to || "").slice(0, 10);
    const invoices = await tsGetAll("invoices");
    const products = await tsGetAll("products");
    const clients = await tsGetAll("clients");
    const taxSlabs = await tsGetAll("tax_slabs");
    const prodById = {};
    for (const p of products) prodById[p.id] = p;
    const clientById = {};
    for (const c of clients) clientById[c.id] = c;
    const slabById = {};
    for (const t of taxSlabs) slabById[t.id] = t;

    const inRange = (iso) => {
      const d = String(iso || "").slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };

    const filtered = invoices.filter(inv => inRange(inv.created_at));

    // Tax liability by rate
    const byRate = {}; // rate -> { taxable, tax, invoices }
    // HSN summary
    const byHsn = {}; // hsn -> { taxable, tax, qty, description }
    // B2B vs B2C (client with GSTIN = B2B)
    let b2bTaxable = 0, b2bTax = 0, b2cTaxable = 0, b2cTax = 0;
    const b2bInvoices = [];
    const b2cInvoices = [];
    let totalTaxable = 0, totalTax = 0, totalInvoiceValue = 0;

    for (const inv of filtered) {
      const client = inv.client_id ? clientById[inv.client_id] : null;
      const gstin = (client && client.gstin) ? String(client.gstin).trim() : "";
      const isB2B = gstin.length >= 15;
      const invTaxable = Math.max(0, (Number(inv.subtotal) || 0) - (Number(inv.discount) || 0));
      const invTax = Number(inv.tax_amount) || 0;
      totalTaxable += invTaxable;
      totalTax += invTax;
      totalInvoiceValue += Number(inv.total) || 0;
      if (isB2B) {
        b2bTaxable += invTaxable; b2bTax += invTax;
        b2bInvoices.push({
          invoice_number: inv.invoice_number, date: String(inv.created_at || "").slice(0, 10),
          client_name: inv.client_name || client.name || "", gstin,
          taxable: Math.round(invTaxable * 100) / 100, tax: Math.round(invTax * 100) / 100,
          total: Number(inv.total) || 0, status: inv.status,
        });
      } else {
        b2cTaxable += invTaxable; b2cTax += invTax;
        b2cInvoices.push({
          invoice_number: inv.invoice_number, date: String(inv.created_at || "").slice(0, 10),
          client_name: inv.client_name || "Walk-in",
          taxable: Math.round(invTaxable * 100) / 100, tax: Math.round(invTax * 100) / 100,
          total: Number(inv.total) || 0, status: inv.status,
        });
      }

      for (const it of inv.items || []) {
        const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
        const rate = Number(it.tax_percent ?? it.taxPercent) || 0;
        const lineTax = line * (rate / 100);
        if (!byRate[rate]) byRate[rate] = { rate, taxable: 0, tax: 0, lines: 0 };
        byRate[rate].taxable += line;
        byRate[rate].tax += lineTax;
        byRate[rate].lines += 1;

        const prod = it.product_id ? prodById[it.product_id] : null;
        const hsn = (prod && prod.hsn_code) ? String(prod.hsn_code).trim() : (it.hsn_code || "UNCLASSIFIED");
        if (!byHsn[hsn]) byHsn[hsn] = { hsn, description: (prod && prod.name) || it.name || "", qty: 0, taxable: 0, tax: 0, rate };
        byHsn[hsn].qty += Number(it.qty) || 0;
        byHsn[hsn].taxable += line;
        byHsn[hsn].tax += lineTax;
        if (rate) byHsn[hsn].rate = rate;
      }
    }

    const rateRows = Object.values(byRate).map(r => ({
      rate: r.rate,
      taxable: Math.round(r.taxable * 100) / 100,
      cgst: Math.round((r.tax / 2) * 100) / 100,
      sgst: Math.round((r.tax / 2) * 100) / 100,
      igst: 0, // intra-state assumed for local-first POS
      tax: Math.round(r.tax * 100) / 100,
      lines: r.lines,
    })).sort((a, b) => a.rate - b.rate);

    const hsnRows = Object.values(byHsn).map(h => ({
      hsn: h.hsn,
      description: h.description,
      qty: Math.round(h.qty * 1000) / 1000,
      rate: h.rate,
      taxable: Math.round(h.taxable * 100) / 100,
      cgst: Math.round((h.tax / 2) * 100) / 100,
      sgst: Math.round((h.tax / 2) * 100) / 100,
      tax: Math.round(h.tax * 100) / 100,
    })).sort((a, b) => String(a.hsn).localeCompare(String(b.hsn)));

    if (parts[1] === "summary" || !parts[1]) {
      return {
        ok: true, from: from || null, to: to || null,
        invoiceCount: filtered.length,
        totalTaxable: Math.round(totalTaxable * 100) / 100,
        totalTax: Math.round(totalTax * 100) / 100,
        totalCgst: Math.round((totalTax / 2) * 100) / 100,
        totalSgst: Math.round((totalTax / 2) * 100) / 100,
        totalIgst: 0,
        totalInvoiceValue: Math.round(totalInvoiceValue * 100) / 100,
        b2b: { count: b2bInvoices.length, taxable: Math.round(b2bTaxable * 100) / 100, tax: Math.round(b2bTax * 100) / 100 },
        b2c: { count: b2cInvoices.length, taxable: Math.round(b2cTaxable * 100) / 100, tax: Math.round(b2cTax * 100) / 100 },
        byRate: rateRows,
      };
    }
    if (parts[1] === "hsn") {
      return { ok: true, from: from || null, to: to || null, hsn: hsnRows };
    }
    if (parts[1] === "b2b") {
      return { ok: true, from: from || null, to: to || null, invoices: b2bInvoices };
    }
    if (parts[1] === "b2c") {
      return { ok: true, from: from || null, to: to || null, invoices: b2cInvoices };
    }
    if (parts[1] === "gstr1") {
      // Simplified GSTR-1 style export payload
      return {
        ok: true, from: from || null, to: to || null,
        b2b: b2bInvoices,
        b2c: b2cInvoices,
        hsn: hsnRows,
        byRate: rateRows,
        summary: {
          invoiceCount: filtered.length,
          totalTaxable: Math.round(totalTaxable * 100) / 100,
          totalTax: Math.round(totalTax * 100) / 100,
          totalCgst: Math.round((totalTax / 2) * 100) / 100,
          totalSgst: Math.round((totalTax / 2) * 100) / 100,
          totalInvoiceValue: Math.round(totalInvoiceValue * 100) / 100,
        },
      };
    }
  }

  // ---- Cash box, drawings, UPI accounts, day-end reconciliation ----
  if (parts[0] === "cashbox") {
    if (method === "GET") {
      const shifts = await tsGetAllSafe("cash_shifts");
      const open = shifts.find(s => s.status === "open") || null;
      const ledger = await tsGetAllSafe("cash_ledger");
      const drawings = await tsGetAllSafe("drawings");
      const upi = await tsGetAllSafe("upi_accounts");
      const opening = Number(await tsGetSetting("cash_opening_balance", "0")) || 0;
      // Drawings are tracked separately — do NOT also subtract from cash_sales
      const drawingsTotal = (drawings || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      // Prefer open shift float; otherwise fall back to saved opening balance
      const baseOpen = open ? (Number(open.opening_float) || 0) : opening;
      const cashSales = open ? (Number(open.cash_sales) || 0) : 0;
      // expected cash in drawer = opening float + cash sales − owner drawings
      const expectedCash = baseOpen + cashSales - drawingsTotal;
      const adjustments = (ledger || [])
        .filter(r => r.type === "adjustment" && r.method === "cash")
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return {
        ok: true,
        openingBalance: opening,
        shiftOpeningFloat: open ? (Number(open.opening_float) || 0) : null,
        openShift: open,
        expectedCash: Math.round(expectedCash * 100) / 100,
        drawingsTotal: Math.round(drawingsTotal * 100) / 100,
        adjustments: Math.round(adjustments * 100) / 100,
        cashSales,
        upiSales: open ? (Number(open.upi_sales) || 0) : 0,
        cardSales: open ? (Number(open.card_sales) || 0) : 0,
        otherSales: open ? (Number(open.other_sales) || 0) : 0,
        upiAccounts: upi,
        formula: "opening_float + cash_sales − drawings",
        recentLedger: (ledger || []).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 40),
        recentDrawings: (drawings || []).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 40),
      };
    }
    if (method === "POST") {
      // Set / adjust opening cash balance for the cash case
      if (body.openingBalance != null || body.opening_balance != null) {
        const val = Number(body.openingBalance ?? body.opening_balance) || 0;
        await tsSetSetting("cash_opening_balance", String(val));
        await tsAdd("cash_ledger", {
          type: "opening_balance", amount: val, method: "cash", ref_type: "setting", ref_id: null,
          notes: body.notes || "Opening cash balance set", created_at: tsNowIso(),
        });
        tsNotify("cashbox");
        return { ok: true, openingBalance: val };
      }
      // Manual cash adjustment / balance amount
      if (body.adjust != null || body.balanceAmount != null) {
        const amt = Number(body.adjust ?? body.balanceAmount) || 0;
        const note = body.notes || "Cash balance adjustment";
        await tsAdd("cash_ledger", {
          type: "adjustment", amount: amt, method: "cash", ref_type: "manual", ref_id: null,
          notes: note, created_at: tsNowIso(),
        });
        // Also reflect on open shift if present
        const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
        if (shift && amt) {
          shift.cash_sales = (Number(shift.cash_sales) || 0) + amt;
          await tsPut("cash_shifts", shift);
          tsNotify("shifts");
        }
        tsNotify("cashbox");
        return { ok: true };
      }
      return { ok: false, error: "Provide openingBalance or adjust." };
    }
  }

  if (parts[0] === "drawings") {
    if (method === "GET") {
      const rows = await tsGetAllSafe("drawings");
      rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      return { ok: true, drawings: rows };
    }
    if (method === "POST") {
      const amt = Number(body.amount) || 0;
      if (amt <= 0) return { ok: false, error: "Amount required." };
      const who = tsWhoami();
      const id = await tsAdd("drawings", {
        amount: amt,
        reason: body.reason || body.notes || "Drawing",
        method: (body.method || "cash").toLowerCase(),
        user_email: who.email || "",
        user_name: who.name || "",
        created_at: tsNowIso(),
      });
      await tsAdd("cash_ledger", {
        type: "drawing", amount: -amt, method: (body.method || "cash").toLowerCase(),
        ref_type: "drawing", ref_id: id, notes: body.reason || "Drawing", created_at: tsNowIso(),
      });
      // Drawings reduce expected cash via drawingsTotal only (not cash_sales)
      tsNotify("cashbox");
      tsNotify("shifts");
      return { ok: true, id };
    }
    if (parts.length === 2 && method === "DELETE") {
      const id = parseInt(parts[1], 10);
      const row = await tsGet("drawings", id);
      if (row) {
        await tsAdd("cash_ledger", {
          type: "drawing_reverse", amount: Number(row.amount) || 0, method: row.method || "cash",
          ref_type: "drawing", ref_id: id, notes: "Drawing deleted", created_at: tsNowIso(),
        });
        await tsDelete("drawings", id);
        tsNotify("cashbox");
      }
      return { ok: true };
    }
  }

  if (parts[0] === "upi-accounts") {
    if (method === "GET") {
      return { ok: true, accounts: await tsGetAllSafe("upi_accounts") };
    }
    if (method === "POST") {
      const id = await tsAdd("upi_accounts", {
        name: body.name || "UPI",
        upi_id: body.upiId || body.upi_id || "",
        bank: body.bank || "",
        notes: body.notes || "",
        opening_balance: Number(body.openingBalance ?? body.opening_balance) || 0,
        active: body.active === false ? 0 : 1,
        created_at: tsNowIso(),
      });
      tsNotify("cashbox");
      return { ok: true, id };
    }
    if (parts.length === 2 && method === "PUT") {
      const id = parseInt(parts[1], 10);
      const row = await tsGet("upi_accounts", id);
      if (!row) return { ok: false, error: "Not found." };
      if (body.name != null) row.name = body.name;
      if (body.upiId != null || body.upi_id != null) row.upi_id = body.upiId ?? body.upi_id;
      if (body.bank != null) row.bank = body.bank;
      if (body.notes != null) row.notes = body.notes;
      if (body.openingBalance != null || body.opening_balance != null) row.opening_balance = Number(body.openingBalance ?? body.opening_balance) || 0;
      if (body.active != null) row.active = body.active ? 1 : 0;
      await tsPut("upi_accounts", row);
      tsNotify("cashbox");
      return { ok: true };
    }
    if (parts.length === 2 && method === "DELETE") {
      await tsDelete("upi_accounts", parseInt(parts[1], 10));
      tsNotify("cashbox");
      return { ok: true };
    }
  }

  if (parts[0] === "day-end" && method === "POST") {
    // Match counted cash / UPI vs expected for the open shift (or today)
    const countedCash = Number(body.countedCash ?? body.counted_cash) || 0;
    const countedUpi = Number(body.countedUpi ?? body.counted_upi) || 0;
    const countedCard = Number(body.countedCard ?? body.counted_card) || 0;
    const notes = body.notes || "";
    const shift = (await tsGetAll("cash_shifts")).find(s => s.status === "open");
    const opening = Number(await tsGetSetting("cash_opening_balance", "0")) || 0;
    const drawings = await tsGetAll("drawings");
    const drawingsToday = (drawings || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const baseOpen = shift ? (Number(shift.opening_float) || 0) : opening;
    const expectedCash = baseOpen + (shift ? (Number(shift.cash_sales) || 0) : 0) - drawingsToday;
    const expectedUpi = shift ? (Number(shift.upi_sales) || 0) : 0;
    const expectedCard = shift ? (Number(shift.card_sales) || 0) : 0;
    const cashVar = Math.round((countedCash - expectedCash) * 100) / 100;
    const upiVar = Math.round((countedUpi - expectedUpi) * 100) / 100;
    const cardVar = Math.round((countedCard - expectedCard) * 100) / 100;
    const result = {
      date: new Date().toISOString().slice(0, 10),
      countedCash, countedUpi, countedCard,
      expectedCash: Math.round(expectedCash * 100) / 100,
      expectedUpi, expectedCard,
      cashVariance: cashVar, upiVariance: upiVar, cardVariance: cardVar,
      drawingsTotal: drawingsToday,
      notes, created_at: tsNowIso(),
      shift_id: shift ? shift.id : null,
    };
    await tsAdd("cash_ledger", {
      type: "day_end", amount: cashVar, method: "cash", ref_type: "day_end", ref_id: null,
      notes: "Day-end reconcile · cash var " + cashVar + " · UPI var " + upiVar + (notes ? " · " + notes : ""),
      payload: result, created_at: tsNowIso(),
    });
    if (body.closeShift && shift) {
      shift.closing_cash = countedCash;
      shift.expected_cash = expectedCash;
      shift.variance = cashVar;
      shift.closed_at = tsNowIso();
      shift.status = "closed";
      shift.notes = ((shift.notes || "") + " | Day-end: " + notes).trim();
      await tsPut("cash_shifts", shift);
      tsNotify("shifts");
    }
    tsNotify("cashbox");
    return { ok: true, reconciliation: result };
  }

  if (parts[0] === "day-end" && method === "GET") {
    const ledger = await tsGetAll("cash_ledger");
    const rows = (ledger || []).filter(r => r.type === "day_end")
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return { ok: true, history: rows };
  }

  return { ok: false, error: "Local API: unhandled path " + path + " [" + method + "]" };
}


async function tsBuildBackupPayload() {
  const stores = [
    "products","clients","invoices","settings","tax_slabs","suppliers","purchases",
    "inventory_movements","payments","quotations","product_variants","product_batches",
    "saved_codes","cash_shifts","held_bills","price_lists","price_list_items","returns",
    "coupons","price_overrides","invoice_layouts","credit_transactions","meta",
    "cash_ledger","drawings","upi_accounts",
  ];
  const data = {};
  for (const s of stores) {
    try { data[s] = await tsGetAll(s); } catch (e) { data[s] = []; }
  }
  // Exclude password hashes from users backup for safety — still include role roster without secrets
  try {
    data.users = (await tsGetAllUsers()).map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at || u.createdAt,
    }));
  } catch (e) { data.users = []; }

  // Photo / media stats (photos live as data-URLs on products + branding settings)
  let photoCount = 0;
  try {
    for (const p of (data.products || [])) {
      if (p && p.photo_path && String(p.photo_path).length > 32) photoCount++;
    }
  } catch (e) {}
  let brandingAssets = 0;
  try {
    const settings = data.settings || [];
    const list = Array.isArray(settings) ? settings : Object.entries(settings).map(([key, value]) => ({ key, value }));
    for (const r of list) {
      const k = String((r && r.key) || "");
      const v = r && r.value;
      if (/logo|qr|photo|image|upi_qr|custom_brand/i.test(k) && v && String(v).length > 32) brandingAssets++;
    }
  } catch (e) {}

  return {
    format: "orbitbills-local-backup",
    version: 2,
    exportedAt: tsNowIso(),
    deviceId: (typeof localStorage !== "undefined" && localStorage.getItem("ts_device_id")) || "",
    includes: {
      products: true,
      productPhotos: true,
      clients: true,
      invoices: true,
      invoiceLayouts: true,
      brandingSettings: true,
      inventory: true,
      taxSlabs: true,
    },
    stats: {
      products: (data.products || []).length,
      productPhotos: photoCount,
      clients: (data.clients || []).length,
      invoices: (data.invoices || []).length,
      invoiceLayouts: (data.invoice_layouts || []).length,
      brandingAssets: brandingAssets,
    },
    stores: data,
  };
}

/**
 * Restore backup.
 * options.mode: "replace" (default) wipes each selected store then writes backup rows
 *               "merge" keeps existing local rows; backup rows upsert by id (or key for settings)
 * options.only: optional array of store names to restore; null/undefined = all present in backup
 */
async function tsRestoreBackupPayload(payload, options) {
  options = options || {};
  const mode = (options.mode === "merge") ? "merge" : "replace";
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const stores = (payload && payload.stores) ? payload.stores : payload;
  if (!stores || typeof stores !== "object") throw new Error("Invalid backup structure");
  const order = [
    "tax_slabs","settings","invoice_layouts","products","product_variants","product_batches",
    "clients","credit_transactions","suppliers","purchases","invoices","payments","quotations",
    "inventory_movements","saved_codes","cash_shifts","held_bills","price_lists","price_list_items",
    "returns","coupons","price_overrides","meta","cash_ledger","drawings","upi_accounts","users",
  ];
  // Also restore any extra stores present in backup not listed above
  const extra = Object.keys(stores).filter(k => order.indexOf(k) < 0 && k !== "users");
  const allNames = order.concat(extra);
  for (const name of allNames) {
    if (!Object.prototype.hasOwnProperty.call(stores, name)) continue;
    if (only && !only.has(name)) continue;
    // Skip users in merge/replace unless explicitly selected (no passwords in backup)
    if (name === "users" && !(only && only.has("users"))) continue;
    const rows = stores[name];
    if (!Array.isArray(rows) && name !== "settings") continue;
    try {
      if (name === "settings") {
        if (mode === "replace") await tsClear("settings");
        if (Array.isArray(rows)) {
          for (const r of rows) if (r && r.key != null) await tsPut("settings", r);
        } else if (rows && typeof rows === "object") {
          for (const [k, v] of Object.entries(rows)) await tsSetSetting(k, v);
        }
      } else {
        if (mode === "replace") await tsClear(name);
        for (const row of rows) {
          if (row == null) continue;
          await tsPut(name, row);
        }
      }
    } catch (e) {
      console.warn("Restore skip", name, e);
    }
  }
}

/** Minimal ZIP (store only) for a single file — pure JS, no CDN. */
function tsZipSingleFile(filename, textContent) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(filename);
  const data = enc.encode(textContent);
  const crc = tsCrc32(data);
  const localHeader = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(localHeader.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, 0, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, 0, true);
  dv.setUint32(14, crc, true);
  dv.setUint32(18, data.length, true);
  dv.setUint32(22, data.length, true);
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true);
  localHeader.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, 0, true);
  cv.setUint16(14, 0, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint16(30, 0, true);
  cv.setUint16(32, 0, true);
  cv.setUint16(34, 0, true);
  cv.setUint16(36, 0, true);
  cv.setUint32(38, 0, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  const offsetCentral = localHeader.length + data.length;
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, offsetCentral, true);
  ev.setUint16(20, 0, true);

  return new Blob([localHeader, data, central, end], { type: "application/zip" });
}

function tsCrc32(buf) {
  let c = 0xffffffff;
  const table = tsCrc32.table || (tsCrc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })());
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function tsDownloadBackupZip() {
  const payload = await tsBuildBackupPayload();
  const json = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const innerName = "orbitbills-backup-" + stamp + ".json";
  const blob = tsZipSingleFile(innerName, json);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "orbitbills-backup-" + stamp + ".zip";
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, filename: a.download };
}

async function tsRestoreFromFile(file, options) {
  if (!file) throw new Error("No file selected.");
  const opts = options || {};
  const buf = new Uint8Array(await file.arrayBuffer());
  let text = "";
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  const name = String(file.name || "").toLowerCase();
  if (isZip || name.endsWith(".zip")) {
    text = await tsExtractFirstZipText(buf);
  } else {
    text = new TextDecoder().decode(buf);
  }
  if (text.charAt(0) === "P" && text.charAt(1) === "K") {
    text = await tsExtractFirstZipText(buf);
  }
  text = String(text || "").replace(/^\uFEFF/, "").trim();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    throw new Error("Backup file is not valid JSON. Choose the OrbitBills .zip file (or the .json inside it).");
  }
  if (payload && payload.stores && typeof payload.stores === "object") {
    await tsRestoreBackupPayload(payload, opts);
  } else if (payload && typeof payload === "object" && (payload.products || payload.invoices || payload.clients || payload.invoice_layouts)) {
    await tsRestoreBackupPayload({ format: "orbitbills-local-backup", stores: payload }, opts);
  } else {
    await tsRestoreBackupPayload(payload, opts);
  }
  return { ok: true, mode: (opts.mode === "merge" ? "merge" : "replace") };
}

async function tsExtractFirstZipText(buf) {
  let found = -1;
  for (let i = 0; i < Math.min(buf.length - 4, 1024); i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      found = i; break;
    }
  }
  if (found < 0) {
    const maybe = new TextDecoder().decode(buf.slice(0, Math.min(buf.length, 64))).trim();
    if (maybe.startsWith("{") || maybe.startsWith("[")) return new TextDecoder().decode(buf);
    throw new Error("Not a ZIP file (missing PK header).");
  }
  const off = found;
  if (buf.length < off + 30) throw new Error("ZIP file is truncated.");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const method = dv.getUint16(off + 8, true);
  let compSize = dv.getUint32(off + 18, true);
  const uncompSize = dv.getUint32(off + 22, true);
  const start = off + 30 + nameLen + extraLen;
  if (compSize === 0 && uncompSize === 0) {
    let end = start;
    for (let i = start; i < buf.length - 3; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && (buf[i + 2] === 0x01 || buf[i + 2] === 0x03 || buf[i + 2] === 0x05)) {
        end = i; break;
      }
    }
    compSize = Math.max(0, end - start);
  }
  const slice = buf.slice(start, start + compSize);
  if (method === 0) return new TextDecoder().decode(slice);
  if (method === 8 && typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([slice]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    } catch (e1) {
      const ds2 = new DecompressionStream("deflate");
      const stream2 = new Blob([slice]).stream().pipeThrough(ds2);
      return await new Response(stream2).text();
    }
  }
  if (method === 8) throw new Error("This browser cannot decompress ZIP. Use the .json backup.");
  throw new Error("Unsupported ZIP compression method " + method + ".");
}


const TS_TILE_COLORS = ["#0b3d91","#2f6feb","#158a53","#b8860b","#8e44ad","#c0392b","#0f766e"];
function tsColorForName(name) {
  let hash = 0; for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return TS_TILE_COLORS[Math.abs(hash) % TS_TILE_COLORS.length];
}
if (typeof window !== "undefined") tsSeedDefaults().catch(() => {});
