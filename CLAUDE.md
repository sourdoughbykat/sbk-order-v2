# Sourdough by Kat: ordering app

A live, small-bakery ordering site. Customers pre-order from seasonal menus and pick up. Kat runs the shop from a kitchen page on her phone. **It's live with real customers, so be careful.**

## Who's who
- **The user** (owner/builder) works with Claude. They're comfortable on the GitHub website, but not with the terminal or GitHub Desktop, so Claude does all git work and explains things in plain language.
- **Kat** is the baker. She isn't technical, uses only the kitchen page ("Kat's View"), and must never need database knowledge.

## What's where
| Thing | Where |
|---|---|
| Live customer site | https://sourdoughbykat.github.io (repo `sourdoughbykat/sourdoughbykat.github.io`, local clone `~/Documents/GitHub/sourdoughbykat.github.io`) |
| Kitchen page ("SBK Kitchen", home-screen name "Kat's View") | https://sourdoughbykat.github.io/admin.html |
| This dev repo | `/Users/gko/Documents/ClaudeProject/BreadApp` → `sourdoughbykat/sbk-order-v2`. Test copy at https://sourdoughbykat.github.io/sbk-order-v2/ (**it uses the same live database**) |
| Backend | Supabase project **sbk-orders** (ref `alowjwrdumbuqnoryhre`, us-east-1, free plan), reached via the Supabase connector |
| Retired | Old Google Sheet "Sourdough by Kat Orders" + Apps Script (`apps-script/`). Shop open = FALSE. Don't use. |

## Files
- `index.html`: customer page (one file). It calls RPCs `get_menu`, `place_order`, `join_waitlist` with the publishable key (public by design).
- `admin.html`: kitchen page. Signs in with email + passcode (Supabase password auth; the email is remembered on the device). Tabs: Orders (status buttons, Text customers, Delete with passcode), To bake, Menu & slots (one Save per section, remove pickup time, one active menu), Waitlist (text people), Shop settings (shop open, Zelle/Venmo, sign-in passcode). OPEN/CLOSED sign and View-the-shop link at the top.
- `supabase/migrations/001…007`: full schema history. Add new ones as `008_…sql` and apply with the connector's `apply_migration`.
- `img/icons/*`, `site.webmanifest`, `kitchen.webmanifest`: home-screen icons. The shop is labeled "SBK", the kitchen "Kat's View".

## Database (Supabase, schema `public`)
`settings` (one row) · `menus` (seasonal menus; only one `taking_orders`, enforced by trigger) · `menu_items` (menu_id, item_id, name, price, available, show, …) · `slots` · `orders` (order_num from `order_num_seq`, order_key for duplicate protection, email, status, restocked_at, archived_at, last_texted_at) · `order_lines` (copies item_name and price at order time) · `waitlist` · `admins` (sbkornada@gmail.com) · `kitchen_secrets` (bcrypt hash of the delete passcode) · view `to_bake`.
- **Customers (anon)** can only call the 3 RPCs. RLS gives admins full access (orders and lines can't be deleted directly, only through `delete_order(num, passcode)`).
- **Cancel** (status → Canceled) restocks once via a trigger. Deleting an active order also restocks.
- **The customer API keeps the old JSON keys** `drops` / `drop` (the table was renamed from drops → menus). Don't rename them without updating index.html.

## How to publish a change
1. Edit `index.html` / `admin.html` here, and syntax-check the inline script with macOS `jsc` (`/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -e "checkSyntax('file.js')"`).
2. Test against a **stand-in copy** (fake `window.supabase` client, served with `python3 -m http.server`, driven in the browser pane), never by placing orders in the live DB.
3. Commit + push here, then copy to the live repo:
   - `admin.html`, manifests and icons: copy as-is.
   - `index.html`: remove the test-only bits first: the `noindex` meta line, the "Test version" banner, and the `sbk-order-v2/` part of `og:url` and `og:image`.
4. Push the live repo. Push with:
   `git -c credential.helper= -c 'credential.helper=!/Users/gko/.local/bin/gh auth git-credential' push`
   (`gh` is at `~/.local/bin/gh` and isn't on PATH.)
5. Wait for GitHub Pages (about 1 min) and confirm with curl.

## Safety rules
- **Live data:** test SQL inside `begin … rollback`. Don't run `tests/supabase_test.py` or the rush tests against it (they place orders). A rolled-back insert still uses up an order number. Never `setval` the sequence below a number already issued.
- **Never put passcodes or secrets in the repo.** The delete passcode exists only as a hash in `kitchen_secrets`.
- **Escape everything customers type** (`esc()`) when rendering in admin.html.
- **Ask before** publishing outward-facing changes the user didn't request, and before deleting real data.

## Next up
See `PLAN.md` → "Where we left off".
