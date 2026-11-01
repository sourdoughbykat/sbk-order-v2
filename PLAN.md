# Sourdough by Kat — ordering web app (v2)

A mobile-friendly web page where customers order from a link, with nothing to install. Orders land in Google Sheets through Apps Script and stay correct when many people order at once.

Starting design: the "New look preview" artifact (https://claude.ai/artifact/2MjxA2bNqqdz3yHW9gW9KQ).

## Rule #1: keep the live shop untouched

The live shop is https://sourdoughbykat.github.io, built from the `sourdoughbykat/sourdoughbykat.github.io` repo. Its page sends orders to the live Apps Script web app.

This project uses its own copy of everything:

| | Live (do not touch) | v2 (this project) |
|---|---|---|
| Code | `sourdoughbykat.github.io` repo | this folder → new repo (e.g. `sbk-order-v2`) |
| Web address | sourdoughbykat.github.io | test URL (Netlify / GitHub Pages project site) |
| Google Sheet | current sheet | **copy** of the sheet, renamed "SBK v2 TEST" |
| Apps Script | current deployment | new deployment bound to the copy |
| `API_URL` in the page | live `/exec` URL | the v2 `/exec` URL only, never the live one |

Switching over happens only after testing. Then the live repo's `index.html` gets the new page and the new Apps Script URL, in one change that can be reverted.

## Phases

### 1. Sheets backend (Apps Script)
- Same tabs and columns as the shop's existing sheet: Settings, Waitlist, Drops, Menu, Slots, Orders, OrderLines, Archive, To bake. The only addition is an "Order ID" column on Orders and Archive.
- Setting Status to "Canceled" restocks the items automatically and stamps Restocked.
- `doGet`: returns the menu JSON the page already expects (`ok, shopOpen, bakery, zelle, venmo, acceptCash, drops[items, slots]`), cached for a few seconds.
- `doPost` order: takes `LockService` → re-checks the drop is open, items are in stock and the slot has room → assigns the order number → writes the order rows → decrements stock → releases the lock. If the lock isn't free, it returns `{busy:true}` and the page retries. If stock ran out, it returns `{ok:false, error, refresh:true}`.
- Duplicate protection: each checkout sends a unique `orderId`. A retried or double-tapped order returns the original order instead of creating a second one.
- `doPost` `action:"notify"`: appends to the Waitlist tab.

### 2. Put it on the web
- Free static hosting with a test URL. Later, optionally a custom domain such as `order.sourdoughbykat.com`.
- Link preview (logo + "This week's drop is open") for Instagram, iMessage and WhatsApp.
- A QR code for flyers and pickup bags.
- Compressed photos in `photos/<item-id>.png`.

### 3. Baker view for Kat (optional for v1)
Orders as they arrive, mark paid or picked up, a "what to bake" total, and open/close the shop. The sheet stays the single source of truth.

### 4. Testing before switching over
- Send 20+ simultaneous orders. Stock must never go below zero and order numbers must never repeat.
  - ✅ Nov 1, 2026, on the TEST copy: 25 at once. All 11 places filled with no repeated numbers and no oversold stock or slots. The other 14 were correctly told their slot was full, nobody was left on "busy", and the slowest wait was 22.5 s.
- Test on a real iPhone (Safari) and a real Android phone (Chrome).
- Soft launch with a few friends on the test URL.

## Open questions
- [ ] Is Kat's baker view in v1?
- [ ] Hosting and domain: a free test URL now, a custom domain later?
- [ ] Payments: keep Zelle, Venmo and cash for v1 (Stripe later)?
