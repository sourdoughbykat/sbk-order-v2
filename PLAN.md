# Sourdough by Kat: plan and status

How the app is built and how to publish: see `CLAUDE.md`.

## History
- **Nov 1, 2026:** first built on Google Sheets + Apps Script (rush-tested), then moved to **Supabase**. Switched the live site over at 12:59 PM, and customers launched at 3 PM. Same link: sourdoughbykat.github.io.
- **Since then:**
  - seasonal menus replace weekly "drops" (one active at a time)
  - "drops" renamed to "menus" in the database
  - Kat's View: passcode sign-in, OPEN/CLOSED sign, delete with passcode, remove pickup times, text the waitlist, **Text customers** in the Orders tab
  - checkout now requires an **email**
  - home-screen icons: shop "SBK", kitchen "Kat's View"
- The rush tests on Supabase passed: 25 orders at once, no overselling, slowest wait 0.4 s.

## Where we left off (Nov 8, 2026)

### Next: make Kat's View "Kat-proof" (approved idea, not built yet)
Kat doesn't know how the database works, so the screens should make the right choice for her:
1. **Renaming an item that has orders** asks: "Same product, new name?" (rename) or "A different product?" (add a new item and hide the old one). Items never ordered rename quietly.
2. **A "Hidden / out of season" section** at the bottom of each menu, with **Bring back** (asks for new stock). **+ Add item** warns if the name matches a hidden item ("Bring it back instead?").
3. **Safe delete for items:** a real Delete only for items with no orders. Items with orders can only be hidden, with a short note explaining why.
4. **Group To bake (and future reports) by item_id** with the current name, so a rename never shows as two lines. Today `to_bake` groups by `menu_name, item_name`.
5. **One-line hints** next to risky controls (Hide, Active menu, Delete).

Known data quirk: item `pumpkin-spice-loaf` was renamed to "Mini Choco Chip Muffins" (a different product reusing an ID). Ask the user before changing it.

### After that
- **Reports tab** in Kat's View, plus report views in Supabase: best sellers, sales over time, by menu, pickup times, payments, customers, cancellations, past-order search, CSV download. Group items by item_id.
- **Confirmation emails:** needs a domain + Resend (free tier); checkout already collects email. Optionally a "new order" email to Kat (no domain needed).
- **Domain** decision (also needed for email). The user was going to decide.
- **Optional:**
  - "Add pickup to calendar" button on the receipt
  - a paid texting service (SimpleTexting / ClickSend) if automatic texts are wanted; today Kat texts from her own phone via Kat's View
  - change history log
  - weekly CSV backup
- **Security hardening still open:**
  - limit orders per phone per menu
  - phone number format check
  - Cloudflare Turnstile anti-bot check
  - 2-step verification on Google, GitHub and Supabase (the user does this)
- **Waitlist tab:** built before the user clarified they meant customers who ordered. They may want it removed. Ask.

### Decisions already made
- Payments stay Zelle / Venmo / Cash (no card payments).
- Site stays on GitHub Pages at sourdoughbykat.github.io until a domain is bought.
- Old Google Sheet + Apps Script are retired. Keep them, but don't use them.
