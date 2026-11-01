# Sourdough by Kat: ordering web app (v2)

This is the new version of the ordering page. It's being built and tested separately, so the live shop at sourdoughbykat.github.io keeps running untouched. See [PLAN.md](PLAN.md) for the full plan.

| File | What it is |
|---|---|
| `index.html` | The customer page (the "New look preview" design) |
| `apps-script/Code.gs` | The backend that runs inside the Google Sheet |
| `tests/run-backend-test.sh` | Offline test of the backend with a fake sheet |
| `tests/rush_test.py` | Sends many orders at the same moment to the **test** backend |

## Phase 1 setup: the test sheet and backend

1. Go to https://sheets.new and name the new sheet **SBK v2 TEST**. Use a new sheet, not your live one.
2. Open **Extensions → Apps Script**. Delete what's in `Code.gs` and paste in all of [apps-script/Code.gs](apps-script/Code.gs). Save.
3. In the function menu at the top, pick `setup` and click **Run**. Allow access when Google asks. This creates these tabs, filled with the fall menu:
   - **Settings:** `shopOpen`, Zelle and Venmo details, `acceptCash`, `nextOrderNum`
   - **Drops:** each weekly drop. Tick `open` on the one taking orders.
   - **Items:** the menu. `available` is how many are left. It goes down automatically with each order. Untick `show` to hide an item.
   - **Slots:** pickup times and how many orders each `capacity` allows
   - **Orders** and **OrderLines:** filled in automatically
   - **Notify:** the "tell me when you reopen" list
4. Click **Deploy → New deployment**. Choose the type **Web app**, set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**. Copy the **Web app URL**. It ends in `/exec`.
5. In `index.html`, paste that URL into `const API_URL = "…"`. Use the test URL only, never the live shop's.

### Day-to-day in the sheet
- **Open or close the shop:** `Settings → shopOpen`.
- **Change stock:** edit `Items → available`. The site shows changes within about 15 seconds.
- **Cancel an order:** set its `status` to `Cancelled`. That frees the pickup slot. Add the items back to `available` yourself.
- **After editing Code.gs:** go to **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.

## How orders stay correct when many people order at once
- Only one order is written at a time. Each order re-checks stock and slot room just before it's saved, so nothing is oversold.
- If another order is mid-way, the page waits a moment and retries, up to 3 times.
- Every checkout sends a unique ID. A double tap or a retry after a dropped connection returns the original order instead of creating a second one.
- Prices always come from the sheet, never from the page.
- Text that looks like a formula, such as a phone number starting with `+`, is saved as plain text.

## Tests
```bash
tests/run-backend-test.sh
```
```bash
python3 tests/rush_test.py https://script.google.com/macros/s/YOUR_TEST_ID/exec 25
```
The rush test refuses to run against the live shop's URL. Afterwards, delete the "Rush test" rows and reset the stock in the test sheet.
