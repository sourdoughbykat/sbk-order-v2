-- Rename "drops" to "menus" everywhere in the database, so the Supabase dashboard reads naturally.
-- The website's API is unchanged: get_menu() still returns "drops", place_order() still takes "drop",
-- and receipts still have "drop", so the live ordering page keeps working through the change.

alter table public.drops rename to menus;
alter table public.menu_items  rename column drop_id   to menu_id;
alter table public.slots       rename column drop_id   to menu_id;
alter table public.orders      rename column drop_id   to menu_id;
alter table public.orders      rename column drop_name to menu_name;
alter table public.order_lines rename column drop_id   to menu_id;
alter trigger drops_one_active on public.menus rename to menus_one_active;
alter index public.drops_pkey rename to menus_pkey;

drop view public.to_bake;
create view public.to_bake with (security_invoker = true) as
  select o.menu_name as menu, l.item_name as item, sum(l.qty)::int as to_bake
  from public.order_lines l join public.orders o using (order_num)
  where o.status <> 'Canceled' and o.archived_at is null
  group by o.menu_name, l.item_name
  order by o.menu_name, l.item_name;
revoke all on public.to_bake from anon;

-- Functions are stored as text, so they're recreated with the new names (same behavior).
create or replace function public.get_menu() returns jsonb
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
          from public.menu_items i where i.menu_id = d.id and i.show), '[]'::jsonb),
        'slots', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', x.slot_id, 'label', x.pickup_time,
            'left', greatest(0, x.max_orders - (
              select count(*) from public.orders o
              where o.menu_id = d.id and o.slot_id = x.slot_id and o.status <> 'Canceled' and o.archived_at is null)))
            order by x.sort, x.slot_id)
          from public.slots x where x.menu_id = d.id), '[]'::jsonb))
        order by d.sort, d.id)
      from public.menus d), '[]'::jsonb))
  from public.settings s where s.id = 1;
$$;

create or replace function public.order_receipt(p_order_num int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', true, 'num', o.order_num, 'total', o.total, 'drop', o.menu_name, 'pickup', o.pickup, 'pay', o.payment,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.item_name, 'qty', l.qty, 'price', l.price) order by l.id)
                       from public.order_lines l where l.order_num = o.order_num), '[]'::jsonb))
  from public.orders o where o.order_num = p_order_num;
$$;

create or replace function public.restock_canceled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'Canceled' and old.status is distinct from 'Canceled' and new.restocked_at is null then
    update public.menu_items m
       set available = m.available + l.qty
      from public.order_lines l
     where l.order_num = new.order_num and m.menu_id = l.menu_id and m.item_id = l.item_id;
    new.restocked_at := now();
  end if;
  return new;
end $$;

create or replace function public.delete_order(p_order_num int, p_passcode text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
begin
  if not public.is_admin() then return public.fail('Only SBK Kitchen can delete orders.'); end if;
  if not exists (select 1 from public.kitchen_secrets k
                 where k.id = 1 and k.passcode_hash = extensions.crypt(coalesce(p_passcode, ''), k.passcode_hash)) then
    perform pg_sleep(1);   -- slows down guessing
    return public.fail('Wrong passcode.');
  end if;
  select * into o from public.orders where order_num = p_order_num for update;
  if not found then return public.fail('Order #' || p_order_num || ' is already gone.'); end if;
  if o.restocked_at is null and o.status not in ('Picked up', 'Canceled') and o.archived_at is null then
    update public.menu_items m set available = m.available + l.qty
      from public.order_lines l
     where l.order_num = o.order_num and m.menu_id = l.menu_id and m.item_id = l.item_id;
  end if;
  delete from public.orders where order_num = o.order_num;   -- its order_lines go with it
  return jsonb_build_object('ok', true, 'num', o.order_num);
end $$;

create or replace function public.one_active_menu() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.menus set taking_orders = false where id <> new.id and taking_orders;
  return new;
end $$;

create or replace function public.place_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key   text := left(btrim(coalesce(p ->> 'orderId', '')), 64);
  v_name  text := left(btrim(coalesce(p ->> 'name', '')), 60);
  v_phone text := left(btrim(coalesce(p ->> 'phone', '')), 30);
  v_menu  text := btrim(coalesce(p ->> 'drop', ''));
  v_slot  text := btrim(coalesce(p ->> 'slot', ''));
  v_pay   text := case lower(btrim(coalesce(p ->> 'pay', ''))) when 'zelle' then 'Zelle' when 'venmo' then 'Venmo' when 'cash' then 'Cash' end;
  v_items jsonb := case when jsonb_typeof(p -> 'items') = 'object' then p -> 'items' else '{}'::jsonb end;
  s       public.settings;
  d       public.menus;
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

  select * into d from public.menus where id = v_menu;
  if not found or not d.taking_orders then return public.fail('This menu just closed. Refresh to see what''s available.', true); end if;

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
  select * into sl from public.slots where menu_id = v_menu and slot_id = v_slot for update;
  if not found then return public.fail('That pickup time isn''t available anymore. Choose another.', true); end if;

  -- Re-check for a duplicate now that we hold the lock.
  select order_num into v_num from public.orders where order_key = v_key;
  if found then return public.order_receipt(v_num); end if;

  select count(*) into v_taken from public.orders
   where menu_id = v_menu and slot_id = v_slot and status <> 'Canceled' and archived_at is null;
  if v_taken >= sl.max_orders then return public.fail(sl.pickup_time || ' just filled up. Choose another pickup time.', true); end if;

  -- Lock each item (in a fixed order, so two orders never wait on each other) and check stock.
  for v_w in select value from jsonb_array_elements(v_wanted) order by value ->> 'id' loop
    select * into it from public.menu_items
     where menu_id = v_menu and item_id = v_w ->> 'id' and show for update;
    if not found then return public.fail('Something on your order isn''t on the menu anymore.', true); end if;
    if (v_w ->> 'qty')::int > it.available then
      return public.fail(case when it.available > 0
        then 'Only ' || it.available || ' ' || it.name || ' left. Adjust your order and try again.'
        else it.name || ' just sold out. Adjust your order and try again.' end, true);
    end if;
    v_total := v_total + it.price * (v_w ->> 'qty')::int;
    v_summary := v_summary || case when v_summary = '' then '' else ', ' end || (v_w ->> 'qty') || ' x ' || it.name;
  end loop;

  insert into public.orders (order_key, menu_id, menu_name, customer_name, phone, slot_id, pickup, items_summary, total, payment)
  values (v_key, v_menu, d.name, v_name, v_phone, v_slot, sl.pickup_time, v_summary, v_total, v_pay)
  returning order_num into v_num;

  insert into public.order_lines (order_num, menu_id, item_id, item_name, qty, price)
  select v_num, v_menu, i.item_id, i.name, (w.value ->> 'qty')::int, i.price
    from jsonb_array_elements(v_wanted) w
    join public.menu_items i on i.menu_id = v_menu and i.item_id = w.value ->> 'id';

  update public.menu_items i set available = i.available - (w.value ->> 'qty')::int
    from jsonb_array_elements(v_wanted) w
   where i.menu_id = v_menu and i.item_id = w.value ->> 'id';

  return public.order_receipt(v_num);
exception
  when unique_violation then
    -- Two tabs sent the same checkout at the same instant: return the one that won.
    select order_num into v_num from public.orders where order_key = v_key;
    if found then return public.order_receipt(v_num); end if;
    raise;
end $$;
