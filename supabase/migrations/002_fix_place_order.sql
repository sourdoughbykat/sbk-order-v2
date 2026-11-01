-- Fix: loop variable clashed with a column alias in place_order.
create or replace function public.place_order(p jsonb) returns jsonb
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

