-- Sourdough by Kat — ordering backend on Supabase.
-- Same jobs as apps-script/Code.gs: menu, orders (one at a time, never oversold),
-- duplicate protection, waitlist, cancel → restock, To bake, archive.
--
-- Customers (the "anon" role) can only call get_menu(), place_order() and join_waitlist().
-- They can't read or change any table directly. Kat signs in (email link) and, because
-- her email is in public.admins, can read and edit everything from the baker page.

-- ───────────────────────── Tables ─────────────────────────

create table public.settings (
  id           int primary key default 1 check (id = 1),   -- exactly one row
  bakery_name  text not null default 'Sourdough by Kat',
  zelle        text not null default '',                   -- Zelle email or phone
  zelle_name   text not null default '',
  venmo        text not null default '',                   -- without the @, blank turns Venmo off
  shop_open    boolean not null default true,              -- false shows the sold-out page
  accept_cash  boolean not null default true
);
insert into public.settings (id) values (1);

create table public.drops (
  id             text primary key,                         -- e.g. 'bread'
  name           text not null,                            -- 'Fall Menu'
  pickup         text not null default '',                 -- 'Pickup Monday, 4 to 7 pm'
  order_deadline text not null default '',                 -- 'Orders close Sunday at 8 pm'
  taking_orders  boolean not null default false,
  sort           int not null default 0
);

create table public.menu_items (
  drop_id     text not null references public.drops(id) on update cascade,
  item_id     text not null,
  name        text not null,
  description text not null default '',
  price       numeric(10,2) not null check (price >= 0),
  available   int not null default 0 check (available >= 0),  -- goes down with each order
  show        boolean not null default true,
  emoji       text not null default '',
  photo       text not null default '',
  sort        int not null default 0,
  primary key (drop_id, item_id)
);

create table public.slots (
  drop_id     text not null references public.drops(id) on update cascade,
  slot_id     text not null,
  pickup_time text not null,                                -- 'Monday, 4 to 5 pm'
  max_orders  int not null default 5 check (max_orders >= 0),
  sort        int not null default 0,
  primary key (drop_id, slot_id)
);

create sequence public.order_num_seq start 101;

create table public.orders (
  order_num     int primary key default nextval('public.order_num_seq'),
  order_key     text unique,                                -- one per checkout: stops duplicates
  placed_at     timestamptz not null default now(),
  drop_id       text not null references public.drops(id) on update cascade,
  drop_name     text not null,
  customer_name text not null,
  phone         text not null,
  slot_id       text not null,
  pickup        text not null,
  items_summary text not null,                              -- '1 x Large Pumpkin Spice Loaf, …'
  total         numeric(10,2) not null,
  payment       text not null check (payment in ('Zelle', 'Venmo', 'Cash')),
  status        text not null default 'Awaiting payment'
                check (status in ('Awaiting payment', 'Paid', 'Picked up', 'Canceled')),
  notes         text not null default '',                   -- Kat's own notes
  restocked_at  timestamptz,                                -- set when a canceled order's items go back
  archived_at   timestamptz                                 -- set when Kat archives the order
);
alter sequence public.order_num_seq owned by public.orders.order_num;
create index orders_slot_idx on public.orders (drop_id, slot_id) where status <> 'Canceled' and archived_at is null;

create table public.order_lines (
  id        bigint generated always as identity primary key,
  order_num int not null references public.orders(order_num) on delete cascade,
  drop_id   text not null,
  item_id   text not null,
  item_name text not null,
  qty       int not null check (qty > 0),
  price     numeric(10,2) not null
);
create index order_lines_order_idx on public.order_lines (order_num);

create table public.waitlist (
  id           bigint generated always as identity primary key,
  signed_up_at timestamptz not null default now(),
  email        text not null default '',
  phone        text not null default '',
  last_emailed timestamptz
);
create unique index waitlist_email_uniq on public.waitlist (lower(email)) where email <> '';
create unique index waitlist_phone_uniq on public.waitlist (phone) where phone <> '';

create table public.admins (
  email text primary key                                    -- lower-case emails allowed into the baker page
);

-- To bake: items still to make for orders that aren't canceled or archived.
create view public.to_bake with (security_invoker = true) as
  select o.drop_name as drop, l.item_name as item, sum(l.qty)::int as to_bake
  from public.order_lines l join public.orders o using (order_num)
  where o.status <> 'Canceled' and o.archived_at is null
  group by o.drop_name, l.item_name
  order by o.drop_name, l.item_name;

-- ───────────────────────── Security ─────────────────────────

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

alter table public.settings    enable row level security;
alter table public.drops       enable row level security;
alter table public.menu_items  enable row level security;
alter table public.slots       enable row level security;
alter table public.orders      enable row level security;
alter table public.order_lines enable row level security;
alter table public.waitlist    enable row level security;
alter table public.admins      enable row level security;

-- Only Kat (admins) can touch tables directly. No policy for customers = no access.
create policy admin_all on public.settings    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.drops       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.menu_items  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.slots       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.orders      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.order_lines for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.waitlist    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_read on public.admins     for select to authenticated using (public.is_admin());

revoke all on all tables in schema public from anon;
revoke all on public.to_bake from anon;

-- ───────────────────────── Cancel → restock ─────────────────────────

-- When Kat sets an order to Canceled, its items go back on the menu once and restocked_at is stamped.
create function public.restock_canceled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'Canceled' and old.status is distinct from 'Canceled' and new.restocked_at is null then
    update public.menu_items m
       set available = m.available + l.qty
      from public.order_lines l
     where l.order_num = new.order_num and m.drop_id = l.drop_id and m.item_id = l.item_id;
    new.restocked_at := now();
  end if;
  return new;
end $$;

create trigger orders_restock before update of status on public.orders
  for each row execute function public.restock_canceled();

-- ───────────────────────── Customer functions ─────────────────────────

-- The menu, in the same shape the page used with Apps Script.
create function public.get_menu() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', true,
    'shopOpen', s.shop_open,
    'bakery', s.bakery_name,
    'zelle', s.zelle,
    'zelleName', s.zelle_name,
    'venmo', ltrim(s.venmo, '@'),
    'acceptCash', s.accept_cash,
    'drops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'pickup', d.pickup, 'closes', d.order_deadline, 'open', d.taking_orders,
        'items', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', i.item_id, 'name', i.name, 'desc', i.description, 'price', i.price,
            'qty', i.available, 'art', coalesce(nullif(i.emoji, ''), '🍞'), 'photo', nullif(i.photo, '')))
            order by i.sort, i.name)
          from public.menu_items i where i.drop_id = d.id and i.show), '[]'::jsonb),
        'slots', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', x.slot_id, 'label', x.pickup_time,
            'left', greatest(0, x.max_orders - (
              select count(*) from public.orders o
              where o.drop_id = d.id and o.slot_id = x.slot_id and o.status <> 'Canceled' and o.archived_at is null)))
            order by x.sort, x.slot_id)
          from public.slots x where x.drop_id = d.id), '[]'::jsonb))
        order by d.sort, d.id)
      from public.drops d), '[]'::jsonb))
  from public.settings s where s.id = 1;
$$;

-- Receipt for an order, in the shape the page shows after checkout.
create function public.order_receipt(p_order_num int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', true, 'num', o.order_num, 'total', o.total, 'drop', o.drop_name, 'pickup', o.pickup, 'pay', o.payment,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.item_name, 'qty', l.qty, 'price', l.price) order by l.id)
                       from public.order_lines l where l.order_num = o.order_num), '[]'::jsonb))
  from public.orders o where o.order_num = p_order_num;
$$;

create function public.fail(msg text, refresh boolean default false) returns jsonb
language sql immutable set search_path = '' as $$
  select case when refresh then jsonb_build_object('ok', false, 'error', msg, 'refresh', true)
              else jsonb_build_object('ok', false, 'error', msg) end;
$$;

-- Places an order. Rows for the chosen slot and items are locked while it runs,
-- so two orders for the last loaf can't both succeed.
-- p: {orderId, drop, items:{itemId: qty}, name, phone, slot, pay}
create function public.place_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key   text := left(btrim(coalesce(p ->> 'orderId', '')), 64);
  v_name  text := left(btrim(coalesce(p ->> 'name', '')), 60);
  v_phone text := left(btrim(coalesce(p ->> 'phone', '')), 30);
  v_drop  text := btrim(coalesce(p ->> 'drop', ''));
  v_slot  text := btrim(coalesce(p ->> 'slot', ''));
  v_pay   text := case lower(btrim(coalesce(p ->> 'pay', ''))) when 'zelle' then 'Zelle' when 'venmo' then 'Venmo' when 'cash' then 'Cash' end;
  v_items jsonb := case when jsonb_typeof(p -> 'items') = 'object' then p -> 'items' else '{}'::jsonb end;
  s       public.settings;
  d       public.drops;
  sl      public.slots;
  it      public.menu_items;
  k       text;
  q       int;
  n       numeric;
  v_taken int;
  v_num   int;
  v_total numeric(10,2) := 0;
  v_summary text := '';
  v_wanted jsonb := '[]'::jsonb;
  v_w     jsonb;
begin
  if v_key = '' then return public.fail('Refresh the page and try again.', true); end if;
  if v_name = '' or v_phone = '' or v_slot = '' then
    return public.fail('Add your name, a phone number and a pickup time to place your order.');
  end if;

  -- Retry of an order that already went through: same receipt back.
  select order_num into v_num from public.orders where order_key = v_key;
  if found then return public.order_receipt(v_num); end if;

  select * into s from public.settings where id = 1;
  if not s.shop_open then return public.fail('Pre-orders are closed right now.', true); end if;

  select * into d from public.drops where id = v_drop;
  if not found or not d.taking_orders then return public.fail('Ordering for this drop just closed.', true); end if;

  if v_pay is null then return public.fail('Choose how you''d like to pay.'); end if;
  if v_pay = 'Venmo' and btrim(s.venmo) = '' then return public.fail('Venmo isn''t available. Choose another way to pay.', true); end if;
  if v_pay = 'Cash' and not s.accept_cash then return public.fail('Cash isn''t available. Choose another way to pay.', true); end if;

  if (select count(*) from jsonb_object_keys(v_items)) > 30 then return public.fail('Your order has too many items.'); end if;
  for k in select jsonb_object_keys(v_items) order by 1 loop
    n := case when jsonb_typeof(v_items -> k) = 'number' then floor((v_items ->> k)::numeric) else 0 end;
    if n > 50 then return public.fail('That''s more than we can bake in one order. Message Kat for large orders.'); end if;
    q := n::int;
    if q > 0 then v_wanted := v_wanted || jsonb_build_array(jsonb_build_object('id', k, 'qty', q)); end if;
  end loop;
  if jsonb_array_length(v_wanted) = 0 then return public.fail('Your order is empty.'); end if;

  -- One order per slot at a time from here (the slot row is locked until this order is saved).
  select * into sl from public.slots where drop_id = v_drop and slot_id = v_slot for update;
  if not found then return public.fail('That pickup time isn''t available anymore. Choose another.', true); end if;

  -- Re-check for a duplicate now that we hold the lock.
  select order_num into v_num from public.orders where order_key = v_key;
  if found then return public.order_receipt(v_num); end if;

  select count(*) into v_taken from public.orders
   where drop_id = v_drop and slot_id = v_slot and status <> 'Canceled' and archived_at is null;
  if v_taken >= sl.max_orders then return public.fail(sl.pickup_time || ' just filled up. Choose another pickup time.', true); end if;

  -- Lock each item (in a fixed order, so two orders never wait on each other) and check stock.
  for v_w in select value from jsonb_array_elements(v_wanted) order by value ->> 'id' loop
    select * into it from public.menu_items
     where drop_id = v_drop and item_id = v_w ->> 'id' and show for update;
    if not found then return public.fail('Something on your order isn''t on the menu anymore.', true); end if;
    if (v_w ->> 'qty')::int > it.available then
      return public.fail(case when it.available > 0
        then 'Only ' || it.available || ' ' || it.name || ' left. Adjust your order and try again.'
        else it.name || ' just sold out. Adjust your order and try again.' end, true);
    end if;
    v_total := v_total + it.price * (v_w ->> 'qty')::int;
    v_summary := v_summary || case when v_summary = '' then '' else ', ' end || (v_w ->> 'qty') || ' x ' || it.name;
  end loop;

  insert into public.orders (order_key, drop_id, drop_name, customer_name, phone, slot_id, pickup, items_summary, total, payment)
  values (v_key, v_drop, d.name, v_name, v_phone, v_slot, sl.pickup_time, v_summary, v_total, v_pay)
  returning order_num into v_num;

  insert into public.order_lines (order_num, drop_id, item_id, item_name, qty, price)
  select v_num, v_drop, i.item_id, i.name, (w.value ->> 'qty')::int, i.price
    from jsonb_array_elements(v_wanted) w
    join public.menu_items i on i.drop_id = v_drop and i.item_id = w.value ->> 'id';

  update public.menu_items i set available = i.available - (w.value ->> 'qty')::int
    from jsonb_array_elements(v_wanted) w
   where i.drop_id = v_drop and i.item_id = w.value ->> 'id';

  return public.order_receipt(v_num);
exception
  when unique_violation then
    -- Two tabs sent the same checkout at the same instant: return the one that won.
    select order_num into v_num from public.orders where order_key = v_key;
    if found then return public.order_receipt(v_num); end if;
    raise;
end $$;

-- Joins the "tell me when you reopen" list. Signing up twice is fine and adds nothing.
create function public.join_waitlist(p_email text default '', p_phone text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(left(btrim(coalesce(p_email, '')), 100));
  v_phone text := left(btrim(coalesce(p_phone, '')), 30);
begin
  if v_email = '' and v_phone = '' then return public.fail('Add an email or phone number.'); end if;
  if v_email <> '' and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return public.fail('Check your email address.'); end if;
  if exists (select 1 from public.waitlist w
             where (v_email <> '' and lower(w.email) = v_email) or (v_phone <> '' and w.phone = v_phone)) then
    return jsonb_build_object('ok', true);
  end if;
  insert into public.waitlist (email, phone) values (v_email, v_phone);
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', true);
end $$;

-- Only these three are callable by customers. Everything else is admin-only or internal.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_menu() to anon, authenticated;
grant execute on function public.place_order(jsonb) to anon, authenticated;
grant execute on function public.join_waitlist(text, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
