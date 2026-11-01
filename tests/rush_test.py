#!/usr/bin/env python3
"""
Simulates a rush: many customers pressing "Place order" at the same moment.

Use it only against the TEST deployment (the "SBK v2 TEST" sheet):

    python3 tests/rush_test.py https://script.google.com/macros/s/XXXX/exec 25

It orders 1 of the first in-stock item per customer, then checks that
  - stock went down by exactly the number of successful orders,
  - no order number was used twice,
  - nobody got an order once stock ran out.
Afterwards, delete the test rows from Orders / OrderLines and reset the stock.
"""
import json
import sys
import threading
import time
import urllib.request
import uuid

LIVE_DEPLOYMENT = "AKfycbzc5OqGvLbDdMIBvgjflC1HdOrAMBCJIjoFd64OwnTG0nYByr2NumZkgTyCEhB_7R0DHw"


def call(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def menu(url):
    m = call(url)
    drop = next(d for d in m["drops"] if d["open"])
    return m, drop


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    url = sys.argv[1]
    customers = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    if LIVE_DEPLOYMENT in url:
        sys.exit("That's the LIVE shop's Apps Script URL. Use the TEST deployment.")

    _, drop = menu(url)
    item = next((i for i in drop["items"] if i["qty"] > 0), None)
    slots = [s for s in drop["slots"] if s["left"] > 0]
    if not item or not slots:
        sys.exit("Nothing in stock or no open pickup slots in the test sheet.")
    stock_before = item["qty"]
    print(f"{customers} customers ordering 1 × {item['name']} (stock {stock_before}) at the same moment…")

    results = [None] * customers
    start = threading.Event()

    def customer(n):
        body = {"orderId": str(uuid.uuid4()), "drop": drop["id"], "items": {item["id"]: 1},
                "name": f"Rush test {n + 1}", "phone": "0000000000",
                "slot": slots[n % len(slots)]["id"], "pay": "cash"}
        start.wait()
        t0 = time.time()
        try:
            for attempt in range(3):  # same retry the page does
                r = call(url, body)
                if not r.get("busy"):
                    break
                time.sleep(1.5 + attempt * 1.5)
        except Exception as e:  # network error, timeout
            r = {"ok": False, "error": f"request failed: {e}"}
        r["_secs"] = round(time.time() - t0, 1)
        results[n] = r

    threads = [threading.Thread(target=customer, args=(n,)) for n in range(customers)]
    for t in threads:
        t.start()
    start.set()
    for t in threads:
        t.join()

    ok = [r for r in results if r.get("ok")]
    busy = [r for r in results if r.get("busy")]
    other = [r for r in results if not r.get("ok") and not r.get("busy")]
    nums = [r["num"] for r in ok]
    _, drop_after = menu(url)
    stock_after = next(i for i in drop_after["items"] if i["id"] == item["id"])["qty"]

    print(f"\nplaced: {len(ok)}   still busy after 3 tries: {len(busy)}   refused/errors: {len(other)}")
    print(f"slowest customer waited {max(r['_secs'] for r in results)} s")
    for r in other[:5]:
        print("  refused:", r.get("error"))

    checks = [
        ("no order number used twice", len(nums) == len(set(nums))),
        ("stock went down by exactly the orders placed", stock_before - stock_after == len(ok)),
        ("never sold more than was in stock", len(ok) <= stock_before),
        ("stock never below zero", stock_after >= 0),
    ]
    print()
    for label, good in checks:
        print(("  ok   " if good else "  FAIL ") + label)
    print(f"\nstock {stock_before} → {stock_after}; order numbers {min(nums) if nums else '-'}–{max(nums) if nums else '-'}")
    print("Remember to delete the 'Rush test' rows from Orders and OrderLines and reset the stock.")
    sys.exit(0 if all(g for _, g in checks) else 1)


if __name__ == "__main__":
    main()
