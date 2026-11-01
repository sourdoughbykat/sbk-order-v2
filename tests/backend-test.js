/*
 * Offline test of apps-script/Code.gs against a fake copy of the shop's sheet layout.
 * Run on a Mac with:  tests/run-backend-test.sh
 */
var out = typeof print === "function" ? print : function (s) { console.log(s); };
if (typeof console === "undefined") this.console = { log: out, error: out };

/* ---------- Fake Apps Script services ---------- */
function FakeSheet(name, data) { this.name = name; this.data = data || []; }
FakeSheet.prototype = {
  getName: function () { return this.name; },
  getDataRange: function () { var d = this.data; return { getValues: function () { return d.map(function (r) { return r.slice(); }); } }; },
  getLastRow: function () { return this.data.length; },
  getLastColumn: function () { return this.data.reduce(function (m, r) { return Math.max(m, r.length); }, 0); },
  getRange: function (row, col, nr, nc) {
    var sh = this; nr = nr || 1; nc = nc || 1;
    var api = {
      getSheet: function () { return sh; },
      getLastRow: function () { return row + nr - 1; },
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
      setNumberFormat: function (f) { sh.formats = sh.formats || {}; sh.formats[row + ':' + col] = f; return api; }
    };
    return api;
  },
  setFrozenRows: function () {},
  getMaxRows: function () { return Math.max(this.data.length, 1000); }
};

/* The shop's sheet as it is today (copied layout, test data) */
var ORDER_HEAD = ["Order #", "Placed", "Drop", "Name", "Phone", "Pickup", "Items", "Total", "Payment", "Status", "Slot ID", "Restocked", "Drop ID"];
function freshSheets() {
  var empty5 = ["", "", "", "", false];
  return {
    Settings: new FakeSheet("Settings", [
      ["Setting", "Value", "Notes"],
      ["Bakery name", "Sourdough by Kat", ""],
      ["Zelle email or phone", 2015550100, ""],
      ["Zelle name", "Kat", ""],
      ["Venmo username", "sourdoughbykat", ""],
      ["Shop open", true, ""]
    ]),
    Waitlist: new FakeSheet("Waitlist", [["Signed up", "Email", "Phone", "Last emailed"]]),
    Drops: new FakeSheet("Drops", [
      ["Drop ID", "Name", "Pickup", "Order deadline", "Taking orders", "Sort"],
      ["bread", "Fall Menu", "Pickup Monday, 4 to 7 pm", "Orders close Sunday at 8 pm", true, 1],
      ["pizza", "Pizza Friday", "Pickup Friday", "Thursday", false, 2],
      empty5, empty5
    ]),
    Menu: new FakeSheet("Menu", [
      ["Drop ID", "Item ID", "Name", "Description", "Price", "Available", "Show", "Emoji"],
      ["bread", "psl", "Large Pumpkin Spice Loaf", "Pumpkin shaped Loaf", 20, 11, true],
      ["bread", "pslm", "Mini Pumpkin Spice Loaf", "Pumpkin Shaped Loaf", 10, 12, true],
      ["bread", "spl", "Large Signature Plain Loaf", "Pumpkin Loaf", 18, 5, true],
      ["bread", "muffm", "Mini Pumpkin Spice Choco Chip Muffins", "Priced Per Muffin", 3.5, 5, true],
      ["bread", "gran", "SBK Pumpkin Spice Coconut Date Granola", "Mini Bag", 12, 3, true],
      ["bread", "hide", "Hidden thing", "", 5, 9, false],
      ["", "", "", "", "", "", false], ["", "", "", "", "", "", false]
    ]),
    Slots: new FakeSheet("Slots", [
      ["Drop ID", "Slot ID", "Pickup time", "Max orders"],
      ["bread", "m4", "Monday, 4 to 5 pm", 5],
      ["bread", "m5", "Monday, 5 to 6 pm", 5],
      ["bread", "m6", "Monday, 6 to 7 pm", 5]
    ]),
    Orders: new FakeSheet("Orders", [
      ORDER_HEAD.slice(),
      [102, new Date(), "Fall Menu", "Vee", 2015550101, "Monday, 4 to 5 pm", "1 x Mini Pumpkin Spice Loaf", 10, "Cash", "Awaiting payment", "m4", "", "bread"]
    ]),
    OrderLines: new FakeSheet("OrderLines", [
      ["Order #", "Drop", "Item", "Qty", "Status", "Drop ID", "Item ID"],
      [102, "Fall Menu", "Mini Pumpkin Spice Loaf", 1, "=IFERROR(...)", "bread", "pslm"]
    ]),
    Archive: new FakeSheet("Archive", [ORDER_HEAD.slice(), [101, new Date(), "Bread Monday", "Test", 1, "", "", 39, "Zelle", "Paid", "m4", "", "bread"]]),
    "To bake": new FakeSheet("To bake", [["=IFERROR(QUERY(...))"]])
  };
}
var sheets = freshSheets();
var SpreadsheetApp = {
  getActive: function () {
    return {
      getSheetByName: function (n) { return sheets[n] || null; },
      insertSheet: function (n) { return (sheets[n] = new FakeSheet(n)); }
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
var props = {};
var PropertiesService = { getScriptProperties: function () { return {
  getProperty: function (k) { return props[k] === undefined ? null : props[k]; },
  setProperty: function (k, v) { props[k] = String(v); }
}; } };
var ContentService ={ MimeType: { JSON: "json" }, createTextOutput: function (s) { return { body: s, setMimeType: function () { return this; } }; } };

load("apps-script/Code.gs");

/* ---------- Tiny test runner ---------- */
var passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; out("  ok   " + label); }
  else { failed++; out("  FAIL " + label + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
function get() { cacheStore = {}; return JSON.parse(doGet().body); }
function post(obj) { return JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).body); }
function col(tab, header) { var d = sheets[tab].data, i = d[0].indexOf(header); return d.slice(1).map(function (r) { return r[i]; }); }
function cell(tab, row, header) { return sheets[tab].data[row - 1][sheets[tab].data[0].indexOf(header)]; }
function avail(id) { var d = sheets.Menu.data, h = d[0]; var r = d.find(function (x) { return x[h.indexOf("Item ID")] === id; }); return r[h.indexOf("Available")]; }
function orderRow(num) { var d = sheets.Orders.data; for (var i = 1; i < d.length; i++) if (d[i][0] === num) return i + 1; return -1; }
var n = 0;
function order(over) {
  var base = { orderId: "t" + (++n), drop: "bread", items: { psl: 1 }, name: "Ann", phone: "7325550101", slot: "m5", pay: "zelle" };
  for (var k in over) base[k] = over[k];
  cacheStore = {};
  return post(base);
}

/* ---------- Tests ---------- */
out("setup on the shop's existing sheet");
setup();
check("adds an Order ID column to Orders", sheets.Orders.data[0][13] === "Order ID");
check("setup formats Placed with date and time", sheets.Orders.formats && sheets.Orders.formats["2:2"] === "M/d/yyyy H:mm:ss" && sheets.Archive.formats["2:2"] === "M/d/yyyy H:mm:ss");
check("adds an Order ID column to Archive", sheets.Archive.data[0][13] === "Order ID");
check("doesn't touch other tabs", sheets.Menu.data.length === 9 && sheets.Settings.data.length === 6 && sheets.Waitlist.data.length === 1);
setup();
check("running setup twice adds nothing more", sheets.Orders.data[0].length === 14);

out("menu");
var m = get();
check("menu ok and shop open", m.ok && m.shopOpen === true);
check("settings read by label", m.bakery === "Sourdough by Kat" && m.zelle === "2015550100" && m.zelleName === "Kat" && m.venmo === "sourdoughbykat");
check("cash allowed when there's no 'Accept cash' row", m.acceptCash === true);
check("Fall Menu open with deadline text", m.drops[0].id === "bread" && m.drops[0].open && m.drops[0].closes === "Orders close Sunday at 8 pm");
check("shows only items with Show ticked", m.drops[0].items.length === 5);
check("description, price, emoji fallback", m.drops[0].items[0].desc === "Pumpkin shaped Loaf" && m.drops[0].items[0].price === 20 && m.drops[0].items[0].art === "🍞");
check("existing order counts against its slot (m4: 4 left)", m.drops[0].slots[0].left === 4 && m.drops[0].slots[1].left === 5);

out("placing an order");
var r = order({ items: { psl: 2, muffm: 3 } });
check("order number follows the highest existing (#103)", r.ok && r.num === 103, r);
check("total uses sheet prices (2×20 + 3×3.5 = 50.5)", r.total === 50.5, r);
check("stock reduced in Menu → Available", avail("psl") === 9 && avail("muffm") === 2);
var row = orderRow(103);
check("Orders row in the shop's format", cell("Orders", row, "Drop") === "Fall Menu" && cell("Orders", row, "Items") === "2 x Large Pumpkin Spice Loaf, 3 x Mini Pumpkin Spice Choco Chip Muffins"
  && cell("Orders", row, "Status") === "Awaiting payment" && cell("Orders", row, "Payment") === "Zelle" && cell("Orders", row, "Slot ID") === "m5" && cell("Orders", row, "Drop ID") === "bread" && cell("Orders", row, "Order ID") === "t" + n);
var L = sheets.OrderLines.data;
check("Placed shows date and time", sheets.Orders.formats[row + ":2"] === "M/d/yyyy H:mm:ss");
check("OrderLines rows in the shop's format", L.length === 4 && L[2][0] === 103 && L[2][1] === "Fall Menu" && L[2][2] === "Large Pumpkin Spice Loaf" && L[2][3] === 2 && L[2][5] === "bread" && L[2][6] === "psl", L[2]);
check("OrderLines Status is the lookup formula for its own row", L[2][4] === '=IFERROR(INDEX(Orders!J:J,MATCH(A3,Orders!A:A,0)),"")' && L[3][4].indexOf("MATCH(A4,") > 0, L[2][4]);

out("archiving doesn't reuse numbers");
var moved = sheets.Orders.data.splice(1, 2);
moved.forEach(function (x) { sheets.Archive.data.push(x); });
check("next number is still #104 after orders move to Archive", order({}).num === 104);
var keep = sheets.Orders.data.splice(1);
check("deleting test orders doesn't reuse their numbers (#105)", order({}).num === 105);
sheets.Orders.data = sheets.Orders.data.concat(keep);

out("same order sent twice (retry / double tap)");
cacheStore = {};
var first = post({ orderId: "dup-1", drop: "bread", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
var second = post({ orderId: "dup-1", drop: "bread", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
check("second request returns the same order", first.ok && second.num === first.num, [first, second]);
cacheStore = {};
var third = post({ orderId: "dup-1", drop: "bread", items: { gran: 1 }, name: "Bo", phone: "1", slot: "m5", pay: "cash" });
check("same order rebuilt from the sheet after cache expiry", third.num === first.num && third.lines.length === 1 && third.lines[0].price === 12 && third.pay === "Cash", third);
check("only one order and one granola taken", col("Orders", "Order ID").filter(function (x) { return x === "dup-1"; }).length === 1 && avail("gran") === 2);

out("overselling");
var before = sheets.Orders.data.length;
check("rejects more than 50 of one item", !order({ items: { pslm: 99 } }).ok);
r = order({ items: { spl: 6 } });
check("rejects more than available, says how many are left", !r.ok && /Only 5/.test(r.error) && r.refresh, r);
check("rejected orders write nothing", sheets.Orders.data.length === before && avail("spl") === 5);
check("can buy the last 5", order({ items: { spl: 5 } }).ok);
r = order({ items: { spl: 1 } });
check("then it's sold out", !r.ok && /sold out/.test(r.error), r);
check("sold out shows qty 0 on the menu", get().drops[0].items.find(function (i) { return i.id === "spl"; }).qty === 0);
var pslBefore = avail("psl");
r = order({ items: { psl: 1, spl: 1 } });
check("one sold-out item blocks the whole order and takes no stock", !r.ok && avail("psl") === pslBefore);
check("hidden items can't be ordered", !order({ items: { hide: 1 } }).ok);

out("pickup slots");
var used = col("Orders", "Slot ID").filter(function (s) { return s === "m6"; }).length;
for (var i = used; i < 5; i++) order({ slot: "m6", items: { pslm: 1 } });
r = order({ slot: "m6", items: { pslm: 1 } });
check("6th order in a 5-person slot is refused", !r.ok && /filled up/.test(r.error), r);
check("menu shows the slot as full", get().drops[0].slots[2].left === 0);

out("canceling restocks");
var target = orderRow(first.num), granBefore = avail("gran");
sheets.Orders.data[target - 1][9] = "Canceled";
onEdit({ range: sheets.Orders.getRange(target, 10) });
check("Canceled order's items go back to Available", avail("gran") === granBefore + 1, [granBefore, avail("gran")]);
check("Restocked gets stamped", cell("Orders", target, "Restocked") instanceof Date);
onEdit({ range: sheets.Orders.getRange(target, 10) });
check("editing again doesn't restock twice", avail("gran") === granBefore + 1);
var m6 = orderRow(sheets.Orders.data.find(function (x) { return x[10] === "m6"; })[0]);
sheets.Orders.data[m6 - 1][9] = "Canceled";
onEdit({ range: sheets.Orders.getRange(m6, 10) });
check("canceling frees its pickup slot", order({ slot: "m6", items: { pslm: 1 } }).ok);

out("menu edits show up right away");
cacheStore = {}; doGet();
sheets.Menu.data[1][5] = 0;
onEdit({ range: sheets.Menu.getRange(2, 6) });
check("editing Menu clears the cached menu", JSON.parse(doGet().body).drops[0].items[0].qty === 0);

out("bad input");
check("missing name refused", !order({ name: "" }).ok);
check("unknown item refused", !order({ items: { nope: 1 } }).ok);
check("empty order refused", !order({ items: {} }).ok);
check("unknown payment refused", !order({ pay: "bitcoin" }).ok);
check("closed drop refused", !order({ drop: "pizza", slot: "m4" }).ok);
check("missing orderId refused", !order({ orderId: "" }).ok);
check("garbage body handled", JSON.parse(doPost({ postData: { contents: "{not json" } }).body).ok === false);
r = order({ items: { pslm: 1 }, slot: "m5", name: "=HYPERLINK(\"http://x\")", phone: "+1 732 555 0101" });
row = orderRow(r.num);
check("formula-looking text stored as plain text", r.ok && cell("Orders", row, "Name").charAt(0) === "'" && cell("Orders", row, "Phone").charAt(0) === "'", r);

out("settings");
sheets.Settings.data.push(["Accept cash", false, ""]);
check("'Accept cash' FALSE hides cash", get().acceptCash === false);
check("and refuses cash orders", !order({ pay: "cash" }).ok);
sheets.Settings.data.find(function (x) { return x[0] === "Shop open"; })[1] = false;
check("orders refused when Shop open is FALSE", !order({}).ok && get().shopOpen === false);
sheets.Settings.data.find(function (x) { return x[0] === "Shop open"; })[1] = true;
lockBusy = true;
r = order({});
check("when another order holds the lock, page is told to retry", !r.ok && r.busy === true, r);
lockBusy = false;
check("lock released after every order", !lockHeld);

out("waitlist");
check("email accepted", post({ action: "notify", email: "a@b.co" }).ok);
check("bad email refused", !post({ action: "notify", email: "nope" }).ok);
check("empty refused", !post({ action: "notify" }).ok);
var W = sheets.Waitlist.data;
check("written to Waitlist in its columns", W.length === 2 && W[1][0] instanceof Date && W[1][1] === "a@b.co");

out("setup on a blank sheet");
sheets = {};
setup();
check("creates all tabs with the shop's columns", ["Settings", "Waitlist", "Drops", "Menu", "Slots", "Orders", "OrderLines", "Archive"].every(function (t) { return sheets[t]; })
  && sheets.Orders.data[0].join() === ORDER_HEAD.concat("Order ID").join() && sheets.Menu.data[0][1] === "Item ID");

out("");
out(passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " test(s) failed");
