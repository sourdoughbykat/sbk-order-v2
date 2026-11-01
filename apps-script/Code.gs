/**
 * Sourdough by Kat — ordering backend (v2).
 *
 * Works with the shop's existing sheet layout (Settings, Waitlist, Drops, Menu,
 * Slots, Orders, OrderLines, Archive, To bake). Paste it into
 * Extensions → Apps Script of the TEST copy, run setup() once, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 *
 * GET  → this week's menu as JSON
 * POST → {orderId, drop, items:{itemId:qty}, name, phone, slot, pay}  places an order
 * POST → {action:"notify", email, phone}                             joins the waitlist
 *
 * Orders are placed one at a time behind a lock, so stock and pickup
 * slots can't be oversold when many people check out at once.
 * Setting an order's Status to "Canceled" puts its items back on the menu.
 */

const TAB = {
  settings: "Settings", waitlist: "Waitlist", drops: "Drops", menu: "Menu", slots: "Slots",
  orders: "Orders", lines: "OrderLines", archive: "Archive"
};
/* Settings tab rows, by the label in the "Setting" column */
const SETTING = {
  bakery: "Bakery name", zelle: "Zelle email or phone", zelleName: "Zelle name",
  venmo: "Venmo username", shopOpen: "Shop open", acceptCash: "Accept cash"
};
const STATUS_NEW = "Awaiting payment";
const MENU_CACHE_KEY = "menu";
const MENU_CACHE_SECONDS = 15;
const ORDER_CACHE_SECONDS = 6 * 60 * 60;
const LOCK_WAIT_MS = 30000;
const FIRST_ORDER_NUM = 101;
const PAY = { zelle: "Zelle", venmo: "Venmo", cash: "Cash" };

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
    if (req.action === "notify") return json_(addToWaitlist_(req));
    return json_(placeOrder_(req));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: "Your order didn't go through. Try again in a moment." });
  }
}

/* ---------------- Sheet edits by Kat ---------------- */

/** Runs on every edit in the sheet: refreshes the site's menu, and restocks canceled orders. */
function onEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName();
  if ([TAB.settings, TAB.drops, TAB.menu, TAB.slots].indexOf(name) >= 0) clearMenuCache();
  if (name === TAB.orders && e.range.getLastRow() > 1) restockCanceledOrders();
}

/** Adds the "SBK" menu to the sheet's toolbar. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("SBK")
    .addItem("Restock canceled orders", "restockCanceledOrders")
    .addItem("Refresh the website menu now", "clearMenuCache")
    .addToUi();
}

/**
 * For every order whose Status is "Canceled" and whose Restocked cell is empty,
 * adds its items back to Menu → Available and stamps Restocked with the time.
 */
function restockCanceledOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const orders = readTable_(TAB.orders);
    const todo = orders.rows.filter(o => isCanceled_(o.status) && !str_(o.restocked));
    if (!todo.length) return;
    const lines = readTable_(TAB.lines).rows;
    const menu = readTable_(TAB.menu);
    const availCol = colOf_(menu, "available");
    const restockedCol = colOf_(orders, "restocked");
    todo.forEach(o => {
      lines.filter(l => num_(l.order) === num_(o.order)).forEach(l => {
        const it = menu.rows.find(i => str_(i.dropid) === str_(l.dropid || o.dropid) && str_(i.itemid) === str_(l.itemid));
        if (!it) return;
        it.available = num_(it.available) + num_(l.qty);
        menu.sheet.getRange(it._row, availCol).setValue(it.available);
      });
      orders.sheet.getRange(o._row, restockedCol).setValue(new Date());
    });
    SpreadsheetApp.flush();
    clearMenuCache();
  } finally {
    lock.releaseLock();
  }
}

function clearMenuCache() { CacheService.getScriptCache().remove(MENU_CACHE_KEY); }

/* ---------------- Menu ---------------- */

function buildMenu_() {
  const s = readSettings_();
  const drops = readTable_(TAB.drops).rows;
  const items = readTable_(TAB.menu).rows;
  const slots = readTable_(TAB.slots).rows;
  const used = slotUsage_();
  return {
    ok: true,
    shopOpen: truthy_(s.shopOpen),
    bakery: str_(s.bakery) || "Sourdough by Kat",
    zelle: str_(s.zelle),
    zelleName: str_(s.zelleName),
    venmo: str_(s.venmo).replace(/^@/, ""),
    acceptCash: s.acceptCash === undefined || str_(s.acceptCash) === "" ? true : truthy_(s.acceptCash),
    drops: drops.filter(d => str_(d.dropid)).sort(bySort_).map(d => ({
      id: str_(d.dropid),
      name: str_(d.name),
      pickup: str_(d.pickup),
      closes: str_(d.orderdeadline),
      open: truthy_(d.takingorders),
      items: items.filter(i => str_(i.dropid) === str_(d.dropid) && str_(i.itemid) && truthy_(i.show)).sort(bySort_).map(i => ({
        id: str_(i.itemid),
        name: str_(i.name),
        desc: str_(i.description),
        price: num_(i.price),
        qty: Math.max(0, Math.floor(num_(i.available))),
        art: str_(i.emoji) || "🍞",
        photo: str_(i.photo) || undefined
      })),
      slots: slots.filter(x => str_(x.dropid) === str_(d.dropid) && str_(x.slotid)).map(x => ({
        id: str_(x.slotid),
        label: str_(x.pickuptime),
        left: Math.max(0, Math.floor(num_(x.maxorders)) - (used[slotKey_(d.dropid, x.slotid)] || 0))
      }))
    }))
  };
}

/** Orders per pickup slot in the Orders tab, not counting canceled ones. */
function slotUsage_() {
  const used = {};
  readTable_(TAB.orders).rows.forEach(o => {
    if (!str_(o.order) || isCanceled_(o.status)) return;
    const k = slotKey_(o.dropid, o.slotid);
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

  // Checks that don't depend on other orders happen before waiting in line.
  const s = readSettings_();
  if (!truthy_(s.shopOpen)) return fail_("Pre-orders are closed right now.", true);
  const drop = readTable_(TAB.drops).rows.find(d => str_(d.dropid) === dropId);
  if (!drop || !truthy_(drop.takingorders)) return fail_("Ordering for this drop just closed.", true);
  if (!PAY[payKey]) return fail_("Choose how you'd like to pay.");
  if (payKey === "venmo" && !str_(s.venmo)) return fail_("Venmo isn't available. Choose another way to pay.", true);
  if (payKey === "cash" && s.acceptCash !== undefined && str_(s.acceptCash) !== "" && !truthy_(s.acceptCash)) {
    return fail_("Cash isn't available. Choose another way to pay.", true);
  }
  const slot = readTable_(TAB.slots).rows.find(x => str_(x.dropid) === dropId && str_(x.slotid) === slotId);
  if (!slot) return fail_("That pickup time isn't available anymore. Choose another.", true);
  const want = [];
  for (const id in wanted) {
    const qty = Math.floor(Number(wanted[id]));
    if (!(qty > 0)) continue;
    if (qty > 50) return fail_("That's more than we can bake in one order. Message Kat for large orders.");
    want.push({ id: String(id), qty });
  }
  if (!want.length) return fail_("Your order is empty.");

  // One order at a time from here: re-read stock and slots, then write.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, busy: true, error: "Lots of orders are coming in right now. Wait a few seconds and tap Place order again." };
  }
  try {
    const orders = readTable_(TAB.orders);
    if (orders.rows.some(r => str_(r.orderid) === orderId)) return findOrderReceipt_(orderId);

    const taken = orders.rows.filter(o => str_(o.order) && !isCanceled_(o.status) &&
      str_(o.dropid) === dropId && str_(o.slotid) === slotId).length;
    if (taken >= Math.floor(num_(slot.maxorders))) return fail_(str_(slot.pickuptime) + " just filled up. Choose another pickup time.", true);

    const menu = readTable_(TAB.menu);
    const lines = [];
    for (const w of want) {
      const it = menu.rows.find(i => str_(i.dropid) === dropId && str_(i.itemid) === w.id && truthy_(i.show));
      if (!it) return fail_("Something on your order isn't on the menu anymore.", true);
      const avail = Math.floor(num_(it.available));
      if (w.qty > avail) {
        return fail_(avail > 0
          ? "Only " + avail + " " + str_(it.name) + " left. Adjust your order and try again."
          : str_(it.name) + " just sold out. Adjust your order and try again.", true);
      }
      lines.push({ row: it._row, avail, id: str_(it.itemid), name: str_(it.name), qty: w.qty, price: num_(it.price) });
    }

    // All good: take the next order number, reduce stock, write the order.
    const num = nextOrderNumber_(orders);
    const total = round2_(lines.reduce((t, l) => t + l.qty * l.price, 0));
    const availCol = colOf_(menu, "available");
    lines.forEach(l => menu.sheet.getRange(l.row, availCol).setValue(l.avail - l.qty));

    writeRows_(orders, lastFilledRow_(orders) + 1, [{
      order: num, placed: new Date(), drop: str_(drop.name), name: safe_(name), phone: safe_(phone),
      pickup: str_(slot.pickuptime), items: lines.map(l => l.qty + " x " + l.name).join(", "),
      total, payment: PAY[payKey], status: STATUS_NEW, slotid: slotId, restocked: "", dropid: dropId, orderid: orderId
    }]);
    const statusCol = colLetter_(colOf_(orders, "status")), orderCol = colLetter_(colOf_(orders, "order"));
    const lineSheet = SpreadsheetApp.getActive().getSheetByName(TAB.lines);
    const lineKeys = lineSheet.getRange(1, 1, 1, lineSheet.getLastColumn()).getValues()[0].map(key_);
    writeRows_({ sheet: lineSheet, keys: lineKeys }, lastDataRow_(lineSheet) + 1, lines.map(l => ({
      order: num, drop: str_(drop.name), item: l.name, qty: l.qty, dropid: dropId, itemid: l.id,
      // Status looks up the order's status, like the shop's existing rows do.
      status: row => '=IFERROR(INDEX(Orders!' + statusCol + ':' + statusCol + ',MATCH(A' + row + ',Orders!' + orderCol + ':' + orderCol + ',0)),"")'
    })));
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty("lastOrderNum", String(num));

    const receipt = {
      ok: true, num, total, drop: str_(drop.name), pickup: str_(slot.pickuptime), pay: PAY[payKey],
      lines: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price }))
    };
    cache.put("order:" + orderId, JSON.stringify(receipt), ORDER_CACHE_SECONDS);
    clearMenuCache();
    return receipt;
  } finally {
    lock.releaseLock();
  }
}

/** Rebuilds the receipt for an order already in the sheet (a retry after the first attempt went through). */
function findOrderReceipt_(orderId) {
  const o = readTable_(TAB.orders).rows.find(r => str_(r.orderid) === orderId);
  if (!o) return null;
  const menu = readTable_(TAB.menu).rows;
  const lines = readTable_(TAB.lines).rows.filter(l => num_(l.order) === num_(o.order)).map(l => {
    const it = menu.find(i => str_(i.dropid) === str_(l.dropid) && str_(i.itemid) === str_(l.itemid));
    return { name: str_(l.item), qty: num_(l.qty), price: it ? num_(it.price) : 0 };
  });
  return { ok: true, num: num_(o.order), total: num_(o.total), drop: str_(o.drop),
           pickup: str_(o.pickup), pay: str_(o.payment), lines };
}

/**
 * Next number after the highest ever used, so numbers never repeat after archiving.
 * The last number handed out is remembered, so Archive is only read the very first time.
 */
function nextOrderNumber_(orders) {
  const props = PropertiesService.getScriptProperties();
  let max = Math.floor(num_(props.getProperty("lastOrderNum")));
  if (!max) {
    max = FIRST_ORDER_NUM - 1;
    const archive = SpreadsheetApp.getActive().getSheetByName(TAB.archive);
    if (archive) readTable_(TAB.archive).rows.forEach(r => { max = Math.max(max, Math.floor(num_(r.order))); });
  }
  orders.rows.forEach(r => { max = Math.max(max, Math.floor(num_(r.order))); });
  return max + 1;
}

/** Last row with an order number, from a table already read (checkbox columns can make getLastRow() too high). */
function lastFilledRow_(table) {
  for (let i = table.rows.length - 1; i >= 0; i--) if (str_(table.rows[i][table.keys[0]])) return table.rows[i]._row;
  return 1;
}

/* ---------------- Waitlist ---------------- */

function addToWaitlist_(req) {
  const email = str_(req.email).slice(0, 100);
  const phone = str_(req.phone).slice(0, 30);
  if (!email && !phone) return fail_("Add an email or phone number.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail_("Check your email address.");
  appendRows_(TAB.waitlist, [{ signedup: new Date(), email: safe_(email), phone: safe_(phone) }]);
  return { ok: true };
}

/* ---------------- Sheet helpers ---------------- */

/** "Drop ID" → "dropid", "Order #" → "order": column names are matched loosely. */
function key_(h) { return String(h).toLowerCase().replace(/[^a-z0-9]/g, ""); }

/** Reads a tab into objects keyed by key_(header); each row keeps its sheet row number in _row. */
function readTable_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error("Missing tab: " + name + ". Run setup() first.");
  const values = sheet.getDataRange().getValues();
  const keys = (values[0] || []).map(key_);
  const rows = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    keys.forEach((k, c) => { if (k && !(k in o)) o[k] = v[c]; });
    return o;
  });
  return { sheet, keys, rows };
}

function colOf_(table, k) {
  const c = table.keys.indexOf(k) + 1;
  if (!c) throw new Error("Column missing in " + table.sheet.getName() + ": " + k);
  return c;
}

function colLetter_(c) { let s = ""; for (; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s; return s; }

function readSettings_() {
  const byLabel = {};
  readTable_(TAB.settings).rows.forEach(r => { if (str_(r.setting)) byLabel[key_(r.setting)] = r.value; });
  const out = {};
  for (const k in SETTING) if (key_(SETTING[k]) in byLabel) out[k] = byLabel[key_(SETTING[k])];
  return out;
}

/** Appends rows by column name after the last filled row. */
function appendRows_(name, objs) {
  if (!objs.length) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  const keys = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(key_);
  writeRows_({ sheet, keys }, lastDataRow_(sheet) + 1, objs);
}

/** Writes rows by column name starting at a row. A function value is called with its row number (for formulas). */
function writeRows_(table, start, objs) {
  const rows = objs.map((o, i) => table.keys.map(k => {
    const v = o[k];
    return v === undefined ? "" : typeof v === "function" ? v(start + i) : v;
  }));
  table.sheet.getRange(start, 1, rows.length, table.keys.length).setValues(rows);
}

/** Last row with something in column A (checkbox columns can make getLastRow() too high). */
function lastDataRow_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 1;
  const colA = sheet.getRange(1, 1, last, 1).getValues();
  for (let r = colA.length - 1; r >= 1; r--) if (str_(colA[r][0])) return r + 1;
  return 1;
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
function isCanceled_(v) { return /^cancell?ed$/i.test(str_(v)); }
function slotKey_(drop, slot) { return str_(drop) + "|" + str_(slot); }
function bySort_(a, b) { return num_(a.sort) - num_(b.sort) || a._row - b._row; }
/** Stops customer text like "=HYPERLINK(...)" or "+1 732..." being treated as a formula. */
function safe_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

/* ---------------- One-time setup ---------------- */

/**
 * Gets the sheet ready for v2. Safe to run more than once.
 * - On the shop's existing sheet: only adds the "Order ID" column to Orders and Archive.
 * - On a blank sheet: creates every tab with the same columns as the shop's sheet.
 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const make = (name, headers, rows) => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  };
  const orderCols = ["Order #", "Placed", "Drop", "Name", "Phone", "Pickup", "Items", "Total", "Payment", "Status", "Slot ID", "Restocked", "Drop ID", "Order ID"];

  make(TAB.settings, ["Setting", "Value", "Notes"], [
    [SETTING.bakery, "Sourdough by Kat", "Shown at the top of the ordering page"],
    [SETTING.zelle, "", "Where customers send Zelle payments"],
    [SETTING.zelleName, "", "The name customers will see in Zelle"],
    [SETTING.venmo, "", "Without the @. Leave blank to turn off Venmo"],
    [SETTING.shopOpen, true, "TRUE shows the menu. FALSE shows the sold-out page with the notify sign-up."]
  ]);
  make(TAB.waitlist, ["Signed up", "Email", "Phone", "Last emailed"], []);
  make(TAB.drops, ["Drop ID", "Name", "Pickup", "Order deadline", "Taking orders", "Sort"], []);
  make(TAB.menu, ["Drop ID", "Item ID", "Name", "Description", "Price", "Available", "Show", "Emoji"], []);
  make(TAB.slots, ["Drop ID", "Slot ID", "Pickup time", "Max orders"], []);
  make(TAB.orders, orderCols, []);
  make(TAB.lines, ["Order #", "Drop", "Item", "Qty", "Status", "Drop ID", "Item ID"], []);
  make(TAB.archive, orderCols, []);

  // The shop's existing Orders and Archive tabs need one extra column for duplicate protection.
  [TAB.orders, TAB.archive].forEach(name => {
    const sh = ss.getSheetByName(name);
    const keys = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(key_);
    if (keys.indexOf("orderid") < 0) sh.getRange(1, keys.filter(String).length + 1).setValue("Order ID").setFontWeight("bold");
  });
  clearMenuCache();
}
