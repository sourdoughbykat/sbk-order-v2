# Sourdough by Kat: ordering web app (v2)

This is the new version of the ordering page. It's being built and tested separately, so the live shop at sourdoughbykat.github.io keeps running untouched. See [PLAN.md](PLAN.md) for the full plan.

| File | What it is |
|---|---|
| `index.html` | The customer page (the "New look preview" design) |
| `apps-script/Code.gs` | The backend that runs inside the Google Sheet |
| `tests/run-backend-test.sh` | Offline test of the backend with a fake copy of the sheet |
| `tests/rush_test.py` | Sends many orders at the same moment to the **test** backend |

## The Google Sheet

v2 uses the same sheet layout the shop already has, so nothing changes for Kat:

| Tab | What's in it |
|---|---|
| **Settings** | Bakery name, Zelle email or phone, Zelle name, Venmo username, Shop open. Optional: add a row `Accept cash` = FALSE to hide cash. |
| **Waitlist** | People who asked to be told when pre-orders reopen |
| **Drops** | Each drop. Tick **Taking orders** on the one that's open. |
| **Menu** | Items for each drop. **Available** goes down automatically with each order. Untick **Show** to hide an item. |
| **Slots** | Pickup times and **Max orders** for each one |
| **Orders** / **OrderLines** | Filled in automatically. v2 adds one column at the end of Orders: **Order ID**. |
| **Archive** | Past orders. Order numbers keep counting up from here too. |
| **To bake** | Unchanged. It still totals OrderLines. |

**Day-to-day**
- **Cancel an order:** set its **Status** to `Canceled`. Its items go straight back into **Available**, **Restocked** gets the time, and the pickup slot frees up.
- **Website updates:** edits to Settings, Drops, Menu or Slots show on the website right away.
- The sheet gets an **SBK** menu in the toolbar with "Restock canceled orders" and "Refresh the website menu now", in case you ever need them.

## Phase 1 setup on the TEST copy

Work only in the copy. The live sheet keeps its own code until we switch over.

1. Open the **copy** of the sheet and go to **Extensions → Apps Script**.
2. Select everything in the code file and delete it. That's the old code that came along with the copy. Paste in all of [apps-script/Code.gs](apps-script/Code.gs) and click **Save**.
3. In the function menu at the top, pick **setup** and click **Run**. Allow access when Google asks. On your sheet, this only adds the **Order ID** column to Orders and Archive.
4. Click **Deploy → New deployment**. Click the gear icon and choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**. Copy the **Web app URL**. It ends in `/exec`.
5. Send that URL to Claude. It goes into `index.html` as `API_URL`. Use the test URL only, never the live shop's.

**After any later change to Code.gs:** go to **Deploy → Manage deployments**, click the pencil, set **Version: New version** and click **Deploy**. The URL stays the same.

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
The rush test refuses to run against the live shop's URL. Afterwards, delete the "Rush test" rows from Orders and OrderLines in the test copy and put **Available** back.
