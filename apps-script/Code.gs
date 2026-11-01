/**
 * Sourdough by Kat — ordering backend (v2, TEST sheet only).
 *
 * Paste this into Extensions → Apps Script of the "SBK v2 TEST" sheet.
 * Run setup() once, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). See README.md.
 *
 * GET  → this week's menu as JSON
 * POST → {orderId, drop, items:{itemId:qty}, name, phone, slot, pay}  places an order
 * POST → {action:"notify", email, phone}                             joins the reopen list
 *
 * Orders are placed one at a time behind a lock, so stock and pickup
 * slots can't be oversold when many people check out at once.
 */

const TAB = {
  settings: "Settings", drops: "Drops", items: "Items", slots: "Slots",
  orders: "Orders", lines: "OrderLines", notify: "Notify"
};
const MENU_CACHE_KEY = "menu";
const MENU_CACHE_SECONDS = 15;
const ORDER_CACHE_SECONDS = 6 * 60 * 60;
const LOCK_WAIT_MS = 8000;
const PAY = { zelle: "Zelle", venmo: "Venmo", cash: "Cash" };
const CANCELLED = "Cancelled";

/* ---------------- Web app entry points ---------------- */

function doGet() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(MENU_CACHE_KEY);
  if (hit) return json_(JSON.parse(hit));
  const menu = buildMenu_();
  cache.put(MENU_CACHE_KEY, JSON.stringify(menu), MENU_CACHE_SECONDS);
  return json_(menu);
}

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); }
  catch (err) { return json_({ ok: false, error: "Something went wrong. Refresh the page and try again." }); }
  try {
    if (req.action === "notify") return json_(addNotify_(req));
    return json_(placeOrder_(req));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: "Your order didn't go through. Try again in a moment." });
  }
}

/* ---------------- Menu ---------------- */

function buildMenu_() {
  const s = readSettings_();
  const drops = readTable_(TAB.drops).rows;
  const items = readTable_(TAB.items).rows;
  const slots = readTable_(TAB.slots).rows;
  const used = slotUsage_();
  return {
    ok: true,
    shopOpen: truthy_(s.shopOpen),
    bakery: str_(s.bakery) || "Sourdough by Kat",
    zelle: str_(s.zelle),
    zelleName: str_(s.zelleName),
    venmo: str_(s.venmo),
    acceptCash: truthy_(s.acceptCash),
    drops: drops.filter(d => str_(d.id)).sort(bySort_).map(d => ({
      id: str_(d.id),
      name: str_(d.name),
      pickup: str_(d.pickup),
      closes: str_(d.closes),
      open: truthy_(d.open),
      items: items.filter(i => str_(i.drop) === str_(d.id) && str_(i.id) && truthy_(i.show)).sort(bySort_).map(i => ({
        id: str_(i.id),
        name: str_(i.name),
        desc: str_(i.desc),
        price: num_(i.price),
        qty: Math.max(0, Math.floor(num_(i.available))),
        art: str_(i.art) || "🍞",
        photo: str_(i.photo) || undefined
      })),
      slots: slots.filter(x => str_(x.drop) === str_(d.id) && str_(x.id)).map(x => ({
        id: str_(x.id),
        label: str_(x.label),
        left: Math.max(0, Math.floor(num_(x.capacity)) - (used[slotKey_(d.id, x.id)] || 0))
      }))
    }))
  };
}

/** Orders per pickup slot, not counting cancelled ones. */
function slotUsage_() {
  const used = {};
  readTable_(TAB.orders).rows.forEach(o => {
    if (str_(o.status) === CANCELLED) return;
    const k = slotKey_(o.drop, o.slot);
    used[k] = (used[k] || 0) + 1;
  });
  return used;
}

/* ---------------- Orders ---------------- */

function placeOrder_(req) {
  const orderId = str_(req.orderId).slice(0, 64);
  const name = str_(req.name).slice(0, 60);
  const phone = str_(req.phone).slice(0, 30);
  const dropId = str_(req.drop);
  const slotId = str_(req.slot);
  const payKey = str_(req.pay).toLowerCase();
  const wanted = req.items && typeof req.items === "object" ? req.items : {};

  if (!orderId) return fail_("Refresh the page and try again.", true);
  if (!name || !phone || !slotId) return fail_("Add your name, a phone number and a pickup time to place your order.");

  // A retry of an order that already went through gets the same receipt back.
  const cache = CacheService.getScriptCache();
  const seen = cache.get("order:" + orderId);
  if (seen) return JSON.parse(seen);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, busy: true, error: "Lots of orders are coming in right now. Wait a few seconds and tap Place order again." };
  }
  try {
    const again = cache.get("order:" + orderId) || findOrderReceipt_(orderId);
    if (again) return typeof again === "string" ? JSON.parse(again) : again;

    const s = readSettings_();
    if (!truthy_(s.shopOpen)) return fail_("Pre-orders are closed right now.", true);

    const drop = readTable_(TAB.drops).rows.find(d => str_(d.id) === dropId);
    if (!drop || !truthy_(drop.open)) return fail_("Ordering for this drop just closed.", true);

    if (!PAY[payKey]) return fail_("Choose how you'd like to pay.");
    if (payKey === "venmo" && !str_(s.venmo)) return fail_("Venmo isn't available. Choose another way to pay.", true);
    if (payKey === "cash" && !truthy_(s.acceptCash)) return fail_("Cash isn't available. Choose another way to pay.", true);

    const slot = readTable_(TAB.slots).rows.find(x => str_(x.drop) === dropId && str_(x.id) === slotId);
    if (!slot) return fail_("That pickup time isn't available anymore. Choose another.", true);
    const left = Math.floor(num_(slot.capacity)) - (slotUsage_()[slotKey_(dropId, slotId)] || 0);
    if (left <= 0) return fail_(str_(slot.label) + " just filled up. Choose another pickup time.", true);

    // Check every item before changing anything.
    const itemsTable = readTable_(TAB.items);
    const lines = [];
    for (const id in wanted) {
      const qty = Math.floor(Number(wanted[id]));
      if (!(qty > 0)) continue;
      if (qty > 50) return fail_("That's more than we can bake in one order. Message Kat for large orders.");
      const it = itemsTable.rows.find(i => str_(i.drop) === dropId && str_(i.id) === String(id) && truthy_(i.show));
      if (!it) return fail_("Something on your order isn't on the menu anymore.", true);
      const avail = Math.floor(num_(it.available));
      if (qty > avail) {
        return fail_(avail > 0
          ? "Only " + avail + " " + str_(it.name) + " left. Adjust your order and try again."
          : str_(it.name) + " just sold out. Adjust your order and try again.", true);
      }
      lines.push({ row: it._row, avail, id: str_(it.id), name: str_(it.name), qty, price: num_(it.price) });
    }
    if (!lines.length) return fail_("Your order is empty.");

    // All good: take the next order number, reduce stock, write the order.
    const num = nextOrderNumber_();
    const total = round2_(lines.reduce((t, l) => t + l.qty * l.price, 0));
    const availCol = itemsTable.headers.indexOf("available") + 1;
    lines.forEach(l => itemsTable.sheet.getRange(l.row, availCol).setValue(l.avail - l.qty));

    const now = new Date();
    appendRow_(TAB.orders, {
      num, orderId, placed: now, drop: dropId, name: safe_(name), phone: safe_(phone),
      slot: slotId, pickup: str_(slot.label), pay: PAY[payKey], total, status: "New",
      summary: lines.map(l => l.qty + " × " + l.name).join(", ")
    });
    appendRows_(TAB.lines, lines.map(l => ({
      num, drop: dropId, item: l.id, name: l.name, qty: l.qty, price: l.price, lineTotal: round2_(l.qty * l.price)
    })));
    SpreadsheetApp.flush();

    const receipt = {
      ok: true, num, total, drop: str_(drop.name), pickup: str_(slot.label), pay: PAY[payKey],
      lines: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price }))
    };
    cache.put("order:" + orderId, JSON.stringify(receipt), ORDER_CACHE_SECONDS);
    cache.remove(MENU_CACHE_KEY);
    return receipt;
  } finally {
    lock.releaseLock();
  }
}

/** Rebuilds the receipt for an order already in the sheet (used when the cache has expired). */
function findOrderReceipt_(orderId) {
  const o = readTable_(TAB.orders).rows.find(r => str_(r.orderId) === orderId);
  if (!o) return null;
  const drop = readTable_(TAB.drops).rows.find(d => str_(d.id) === str_(o.drop));
  const lines = readTable_(TAB.lines).rows.filter(l => num_(l.num) === num_(o.num))
    .map(l => ({ name: str_(l.name), qty: num_(l.qty), price: num_(l.price) }));
  return { ok: true, num: num_(o.num), total: num_(o.total), drop: drop ? str_(drop.name) : str_(o.drop),
           pickup: str_(o.pickup), pay: str_(o.pay), lines };
}

function nextOrderNumber_() {
  const t = readTable_(TAB.settings);
  const row = t.rows.find(r => str_(r.key) === "nextOrderNum");
  const num = Math.max(1, Math.floor(num_(row && row.value)) || 101);
  if (row) t.sheet.getRange(row._row, 2).setValue(num + 1);
  else t.sheet.appendRow(["nextOrderNum", num + 1]);
  return num;
}

/* ---------------- Notify list ---------------- */

function addNotify_(req) {
  const email = str_(req.email).slice(0, 100);
  const phone = str_(req.phone).slice(0, 30);
  if (!email && !phone) return fail_("Add an email or phone number.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail_("Check your email address.");
  appendRow_(TAB.notify, { at: new Date(), email: safe_(email), phone: safe_(phone) });
  return { ok: true };
}

/* ---------------- Sheet helpers ---------------- */

/** Reads a tab into objects keyed by the header row; each row keeps its sheet row number in _row. */
function readTable_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error("Missing tab: " + name + ". Run setup() first.");
  const values = sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) o[h] = v[c]; });
    return o;
  });
  return { sheet, headers, rows };
}

function readSettings_() {
  const out = {};
  readTable_(TAB.settings).rows.forEach(r => { if (str_(r.key)) out[str_(r.key)] = r.value; });
  return out;
}

function appendRow_(name, obj) { appendRows_(name, [obj]); }

function appendRows_(name, objs) {
  if (!objs.length) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const rows = objs.map(o => headers.map(h => (o[h] === undefined ? "" : o[h])));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/* ---------------- Small helpers ---------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(error, refresh) { return refresh ? { ok: false, error, refresh: true } : { ok: false, error }; }
function str_(v) { return v == null ? "" : String(v).trim(); }
function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round2_(n) { return Math.round(n * 100) / 100; }
function truthy_(v) { return v === true || /^(true|yes|y|1|open|on)$/i.test(str_(v)); }
function slotKey_(drop, slot) { return str_(drop) + "|" + str_(slot); }
function bySort_(a, b) { return num_(a.sort) - num_(b.sort) || a._row - b._row; }
/** Stops customer text like "=HYPERLINK(...)" or "+1 732..." being treated as a formula. */
function safe_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

/* ---------------- One-time setup ---------------- */

/**
 * Creates any missing tabs with headers and the sample fall menu.
 * Safe to run again: tabs that already exist are left alone.
 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const make = (name, headers, rows, checkboxCols) => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    (checkboxCols || []).forEach(h => {
      const c = headers.indexOf(h) + 1;
      sh.getRange(2, c, Math.max(rows.length, 1) + 50, 1).insertCheckboxes();
    });
    sh.autoResizeColumns(1, headers.length);
  };

  make(TAB.settings, ["key", "value"], [
    ["shopOpen", true],
    ["bakery", "Sourdough by Kat"],
    ["zelle", "sourdoughbykat@email.com"],
    ["zelleName", "Kat"],
    ["venmo", "sourdoughbykat"],
    ["acceptCash", true],
    ["nextOrderNum", 101]
  ]);
  make(TAB.drops, ["id", "name", "pickup", "closes", "open", "sort"], [
    ["fall", "Fall Menu", "Pickup Monday, 4 to 7 pm", "Orders close Sunday at 8 pm", true, 1],
    ["pizza", "Pizza Friday", "Pickup Friday, 5 to 8 pm", "Orders close Thursday at 8 pm", false, 2]
  ], ["open"]);
  make(TAB.items, ["drop", "id", "name", "desc", "price", "available", "art", "photo", "show", "sort"], [
    ["fall", "psl", "Pumpkin spice pumpkin loaf", "Large loaf", 20, 8, "🍞", "", true, 1],
    ["fall", "pslm", "Pumpkin spice pumpkin loaf, mini", "Mini loaf", 12, 10, "🍞", "", true, 2],
    ["fall", "spl", "Signature plain pumpkin loaf", "Large loaf", 18, 8, "🍞", "", true, 3],
    ["fall", "splm", "Signature plain pumpkin loaf, mini", "Mini loaf", 10, 10, "🍞", "", true, 4],
    ["fall", "pscl", "Pumpkin spice choco chip muffin, large", "Priced per muffin", 6.5, 24, "🧁", "", true, 5],
    ["fall", "pscm", "Pumpkin spice choco chip muffin, mini", "Priced per muffin", 3.5, 36, "🧁", "", true, 6],
    ["fall", "gran", "SBK pumpkin spice coconut date granola", "Mini bag", 12, 12, "🥣", "", true, 7]
  ], ["show"]);
  make(TAB.slots, ["drop", "id", "label", "capacity"], [
    ["fall", "m4", "Monday, 4 to 5 pm", 5],
    ["fall", "m5", "Monday, 5 to 6 pm", 5],
    ["fall", "m6", "Monday, 6 to 7 pm", 5]
  ]);
  make(TAB.orders, ["num", "orderId", "placed", "drop", "name", "phone", "slot", "pickup", "pay", "total", "status", "summary"], []);
  make(TAB.lines, ["num", "drop", "item", "name", "qty", "price", "lineTotal"], []);
  make(TAB.notify, ["at", "email", "phone"], []);

  const blank = ss.getSheetByName("Sheet1");
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  CacheService.getScriptCache().remove(MENU_CACHE_KEY);
}

/** Run from the editor after editing the sheet if you want the site to show changes immediately. */
function clearMenuCache() { CacheService.getScriptCache().remove(MENU_CACHE_KEY); }
