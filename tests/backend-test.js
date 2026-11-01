/*
 * Offline test of apps-script/Code.gs against a fake Google Sheet.
 * Run on a Mac with:  tests/run-backend-test.sh
 */
var out = typeof print === "function" ? print : function (s) { console.log(s); };
if (typeof console === "undefined") this.console = { log: out, error: out };

/* ---------- Fake Apps Script services ---------- */
function FakeSheet(name) { this.name = name; this.data = []; }
FakeSheet.prototype = {
  getDataRange: function () { var d = this.data; return { getValues: function () { return d.map(function (r) { return r.slice(); }); } }; },
  getLastRow: function () { return this.data.length; },
  getLastColumn: function () { return this.data.reduce(function (m, r) { return Math.max(m, r.length); }, 0); },
  appendRow: function (row) { this.data.push(row.slice()); },
  getRange: function (row, col, nr, nc) {
    var sh = this; nr = nr || 1; nc = nc || 1;
    var api = {
      getValues: function () {
        var res = [];
        for (var r = 0; r < nr; r++) { var line = []; for (var c = 0; c < nc; c++) { var x = sh.data[row - 1 + r]; line.push(x && x[col - 1 + c] !== undefined ? x[col - 1 + c] : ""); } res.push(line); }
        return res;
      },
      setValues: function (vals) {
        for (var r = 0; r < vals.length; r++) { while (sh.data.length < row + r) sh.data.push([]); for (var c = 0; c < vals[r].length; c++) sh.data[row - 1 + r][col - 1 + c] = vals[r][c]; }
        return api;
      },
      setValue: function (v) { return api.setValues([[v]]); },
      setFontWeight: function () { return api; },
      insertCheckboxes: function () { return api; }
    };
    return api;
  },
  setFrozenRows: function () {}, autoResizeColumns: function () {}
};
var sheets = { Sheet1: new FakeSheet("Sheet1") };
var SpreadsheetApp = {
  getActive: function () {
    return {
      getSheetByName: function (n) { return sheets[n] || null; },
      insertSheet: function (n) { return (sheets[n] = new FakeSheet(n)); },
      getSheets: function () { return Object.keys(sheets).map(function (k) { return sheets[k]; }); },
      deleteSheet: function (s) { delete sheets[s.name]; }
    };
  },
  flush: function () {}
};
var cacheStore = {};
var CacheService = { getScriptCache: function () { return {
  get: function (k) { return cacheStore[k] === undefined ? null : cacheStore[k]; },
  put: function (k, v) { cacheStore[k] = v; },
  remove: function (k) { delete cacheStore[k]; }
}; } };
var lockHeld = false, lockBusy = false;
var LockService = { getScriptLock: function () { return {
  tryLock: function () { if (lockBusy || lockHeld) return false; lockHeld = true; return true; },
  releaseLock: function () { lockHeld = false; }
}; } };
var ContentService = { MimeType: { JSON: "json" }, createTextOutput: function (s) { return { body: s, setMimeType: function () { return this; } }; } };

load("apps-script/Code.gs");

/* ---------- Tiny test runner ---------- */
var passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; out("  ok   " + label); }
  else { failed++; out("  FAIL " + label + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
function get() { return JSON.parse(doGet().body); }
function post(obj) { return JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).body); }
function col(tab, header) { var d = sheets[tab].data, i = d[0].indexOf(header); return d.slice(1).map(function (r) { return r[i]; }); }
function avail(id) { var d = sheets.Items.data, h = d[0]; var r = d.find(function (x) { return x[h.indexOf("id")] === id; }); return r[h.indexOf("available")]; }
var n = 0;
function order(over) {
  var base = { orderId: "t" + (++n), drop: "fall", items: { psl: 1 }, name: "Ann", phone: "7325550101", slot: "m4", pay: "zelle" };
  for (var k in over) base[k] = over[k];
  cacheStore = {};
  return post(base);
}

/* ---------- Tests ---------- */
out("setup");
setup();
check("all tabs created", ["Settings", "Drops", "Items", "Slots", "Orders", "OrderLines", "Notify"].every(function (t) { return sheets[t]; }));
check("blank Sheet1 removed", !sheets.Sheet1);
setup();
check("running setup twice adds nothing", sheets.Items.data.length === 8);

out("menu");
var m = get();
check("menu ok and shop open", m.ok && m.shopOpen === true);
check("fall drop open with 7 items", m.drops[0].id === "fall" && m.drops[0].open && m.drops[0].items.length === 7);
check("slot shows 5 left", m.drops[0].slots[0].left === 5);
check("payment details passed through", m.zelle && m.venmo === "sourdoughbykat" && m.acceptCash === true);

out("placing an order");
var r = order({ items: { psl: 2, pscm: 3 } });
check("order succeeds with number 101", r.ok && r.num === 101, r);
check("total uses sheet prices (2×20 + 3×3.5 = 50.5)", r.total === 50.5, r);
check("stock reduced", avail("psl") === 6 && avail("pscm") === 33);
check("order row written", sheets.Orders.data.length === 2 && col("Orders", "status")[0] === "New");
check("two order lines written", sheets.OrderLines.data.length === 3);
check("next order number advanced", order({}).num === 102);

out("same order sent twice (retry / double tap)");
cacheStore = {};
var first = post({ orderId: "dup-1", drop: "fall", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
var second = post({ orderId: "dup-1", drop: "fall", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
check("second request returns the same order", first.ok && second.num === first.num, [first, second]);
cacheStore = {};
var third = post({ orderId: "dup-1", drop: "fall", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
check("still the same order after cache expiry", third.num === first.num && third.lines.length === 1, third);
check("only one order and one granola taken", col("Orders", "orderId").filter(function (x) { return x === "dup-1"; }).length === 1 && avail("gran") === 11);

out("overselling");
var before = sheets.Orders.data.length;
r = order({ items: { psl: 99 } });
check("rejects more than 50 of one item", !r.ok, r);
r = order({ items: { spl: 9 } });
check("rejects more than available, says how many are left", !r.ok && /Only 8/.test(r.error) && r.refresh, r);
check("rejected orders write nothing", sheets.Orders.data.length === before && avail("spl") === 8);
r = order({ items: { spl: 8 } });
check("can buy the last 8", r.ok);
r = order({ items: { spl: 1 } });
check("then it's sold out", !r.ok && /sold out/.test(r.error), r);
check("sold out shows qty 0 on the menu", (cacheStore = {}, get()).drops[0].items.find(function (i) { return i.id === "spl"; }).qty === 0);
r = order({ items: { psl: 1, spl: 1 } });
check("one sold-out item blocks the whole order and takes no stock", !r.ok && avail("psl") === 5, [r, avail("psl")]);

out("pickup slots");
for (var i = 0; i < 5; i++) order({ slot: "m6", items: { pscl: 1 } });
r = order({ slot: "m6", items: { pscl: 1 } });
check("6th order in a 5-person slot is refused", !r.ok && /filled up/.test(r.error), r);
cacheStore = {};
check("menu shows the slot as full", get().drops[0].slots[2].left === 0);
var st = sheets.Orders.data[0].indexOf("status"), sl = sheets.Orders.data[0].indexOf("slot");
var m6 = sheets.Orders.data.find(function (row) { return row[sl] === "m6"; });
m6[st] = "Cancelled";
r = order({ slot: "m6", items: { pscl: 1 } });
check("cancelling an order frees its slot", r.ok, r);

out("bad input");
check("missing name refused", !order({ name: "" }).ok);
check("unknown item refused", !order({ items: { nope: 1 } }).ok);
check("empty order refused", !order({ items: {} }).ok);
check("unknown payment refused", !order({ pay: "bitcoin" }).ok);
check("closed drop refused", !order({ drop: "pizza", slot: "m4" }).ok);
check("missing orderId refused", !order({ orderId: "" }).ok);
check("garbage body handled", JSON.parse(doPost({ postData: { contents: "{not json" } }).body).ok === false);
r = order({ name: "=HYPERLINK(\"http://x\")", phone: "+1 732 555 0101" });
var names = col("Orders", "name"), phones = col("Orders", "phone");
check("formula-looking text stored as plain text", r.ok && names[names.length - 1].charAt(0) === "'" && phones[phones.length - 1].charAt(0) === "'");

out("shop closed / busy");
sheets.Settings.data.find(function (x) { return x[0] === "shopOpen"; })[1] = false;
check("orders refused when shop is closed", !order({}).ok);
sheets.Settings.data.find(function (x) { return x[0] === "shopOpen"; })[1] = true;
lockBusy = true;
r = order({});
check("when another order holds the lock, page is told to retry", !r.ok && r.busy === true, r);
lockBusy = false;
check("lock released after every order", !lockHeld);

out("notify list");
check("email accepted", post({ action: "notify", email: "a@b.co" }).ok);
check("bad email refused", !post({ action: "notify", email: "nope" }).ok);
check("empty refused", !post({ action: "notify" }).ok);
check("rows written", sheets.Notify.data.length === 2);

out("");
out(passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " test(s) failed");
