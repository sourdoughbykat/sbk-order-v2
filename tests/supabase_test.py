#!/usr/bin/env python3
"""
Tests the Supabase backend the way customers' phones use it (publishable key only).

    python3 tests/supabase_test.py https://PROJECT.supabase.co sb_publishable_... [rush_customers]

Checks: menu, ordering, duplicates, overselling, full slots, bad input, waitlist,
that customers can't read any table, and a rush of simultaneous orders.
It places real test orders: run it on a TEST database, then reset the data.
"""
import json
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

URL, KEY = sys.argv[1].rstrip("/"), sys.argv[2]
RUSH = int(sys.argv[3]) if len(sys.argv) > 3 else 25
passed = failed = 0


def call(path, body=None, method=None):
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(),
                                 method=method or ("POST" if body is not None else "GET"),
                                 headers={"apikey": KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")


def rpc(name, args=None):
    status, body = call("/rest/v1/rpc/" + name, args or {})
    if status != 200:
        raise RuntimeError(f"{name} → {status} {body}")
    return body


def check(label, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + label)
    else:
        failed += 1
        print("  FAIL " + label + (f"  → {extra}" if extra is not None else ""))


def menu():
    return rpc("get_menu")


def item(m, iid):
    return next(i for i in m["drops"][0]["items"] if i["id"] == iid)


def slot(m, sid):
    return next(s for s in m["drops"][0]["slots"] if s["id"] == sid)


def order(**over):
    p = {"orderId": str(uuid.uuid4()), "drop": "bread", "items": {"pslm": 1}, "name": "Test", "phone": "0000000000",
         "slot": "m5", "pay": "zelle"}
    p.update(over)
    return rpc("place_order", {"p": p})


print("menu")
m = menu()
check("menu loads with the shop open", m["ok"] and m["shopOpen"])
check("Fall Menu with 7 items and 3 slots", len(m["drops"][0]["items"]) == 7 and len(m["drops"][0]["slots"]) == 3)

print("customers can't read or change tables")
for t in ["orders", "order_lines", "waitlist", "settings", "menu_items", "admins", "to_bake"]:
    status, body = call(f"/rest/v1/{t}?select=*")
    check(f"reading {t} is refused", status in (401, 403, 404) or body == [], (status, body))
status, _ = call("/rest/v1/menu_items?item_id=eq.psl", {"price": 0}, method="PATCH")
check("changing a price is refused", status in (401, 403, 404))
status, _ = call("/rest/v1/rpc/order_receipt", {"p_order_num": 101})
check("internal functions can't be called", status in (401, 403, 404))

print("placing an order")
before = item(menu(), "pslm")["qty"]
r = order(items={"pslm": 2, "gran": 1}, pay="venmo")
check("order succeeds", r.get("ok") and r.get("num", 0) >= 101, r)
check("total uses database prices (2×10 + 12 = 32)", float(r.get("total", 0)) == 32, r)
check("receipt lists both items", len(r.get("lines", [])) == 2 and r.get("pay") == "Venmo", r)
check("stock reduced", item(menu(), "pslm")["qty"] == before - 2)

print("same order sent twice")
key = str(uuid.uuid4())
a = order(orderId=key, items={"muffl": 1})
b = order(orderId=key, items={"muffl": 1})
check("second request returns the same order number", a.get("ok") and a.get("num") == b.get("num"), (a, b))

print("overselling and bad input")
m = menu()
spl = item(m, "spl")["qty"]
r = order(items={"spl": spl + 1})
check("more than available is refused with how many are left", not r["ok"] and f"Only {spl}" in r["error"] and r.get("refresh"), r)
check("more than 50 refused", not order(items={"psl": 51})["ok"])
check("absurd quantity refused", not order(items={"psl": 1e30})["ok"])
check("text quantity ignored → empty order refused", not order(items={"psl": "5"})["ok"])
check("unknown item refused", not order(items={"nope": 1})["ok"])
check("empty order refused", not order(items={})["ok"])
check("missing name refused", not order(name="")["ok"])
check("missing orderId refused", not order(orderId="")["ok"])
check("unknown payment refused", not order(pay="bitcoin")["ok"])
check("unknown slot refused", not order(slot="zz")["ok"])
check("unknown drop refused", not order(drop="pizza")["ok"])
check("too many different items refused", not order(items={f"x{i}": 1 for i in range(31)})["ok"])

print("waitlist")
e = f"test-{uuid.uuid4().hex[:8]}@example.com"
check("sign-up works", rpc("join_waitlist", {"p_email": e, "p_phone": ""})["ok"])
check("signing up twice is fine", rpc("join_waitlist", {"p_email": e.upper(), "p_phone": ""})["ok"])
check("bad email refused", not rpc("join_waitlist", {"p_email": "nope", "p_phone": ""})["ok"])
check("empty refused", not rpc("join_waitlist", {"p_email": "", "p_phone": ""})["ok"])

print(f"rush: {RUSH} customers at the same moment")
m = menu()
target = max(m["drops"][0]["items"], key=lambda i: i["qty"])
stock = target["qty"]
places = sum(s["left"] for s in m["drops"][0]["slots"])
slots = [s["id"] for s in m["drops"][0]["slots"]]
results = [None] * RUSH
go = threading.Event()


def customer(n):
    go.wait()
    t0 = time.time()
    try:
        results[n] = order(items={target["id"]: 1}, slot=slots[n % len(slots)], name=f"Rush test {n + 1}", pay="cash")
    except Exception as ex:
        results[n] = {"ok": False, "error": str(ex)}
    results[n]["_s"] = time.time() - t0


threads = [threading.Thread(target=customer, args=(n,)) for n in range(RUSH)]
for t in threads:
    t.start()
go.set()
for t in threads:
    t.join()
ok = [r for r in results if r.get("ok")]
errors = [r for r in results if not r.get("ok") and "filled up" not in r.get("error", "") and "sold out" not in r.get("error", "") and "Only" not in r.get("error", "")]
after = menu()
nums = [r["num"] for r in ok]
print(f"  placed {len(ok)} of {RUSH} (stock {stock}, slot places {places}); slowest {max(r['_s'] for r in results):.1f} s")
check("placed exactly as many as stock and slots allow", len(ok) == min(stock, places), (len(ok), stock, places))
check("no order number used twice", len(nums) == len(set(nums)))
check("stock went down by exactly the orders placed", item(after, target["id"])["qty"] == stock - len(ok))
check("no slot over its limit", all(s["left"] >= 0 for s in after["drops"][0]["slots"]))
check("everyone else got a clear 'full' or 'sold out' message, no errors", not errors, errors[:3])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
