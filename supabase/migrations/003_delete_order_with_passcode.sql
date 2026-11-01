-- Deleting an order needs Kat's sign-in AND the delete passcode.
-- The passcode is stored only as a bcrypt hash and is never in this repo. To set or change it,
-- run in the Supabase SQL editor:
--   update public.kitchen_secrets set passcode_hash = extensions.crypt('NEW CODE', extensions.gen_salt('bf')) where id = 1;

create table public.kitchen_secrets (
  id            int primary key default 1 check (id = 1),
  passcode_hash text not null
);
alter table public.kitchen_secrets enable row level security;   -- no policies: nobody reads it through the API
revoke all on public.kitchen_secrets from anon, authenticated;

-- Orders can no longer be deleted directly, only through delete_order() below.
drop policy admin_all on public.orders;
create policy admin_select on public.orders for select to authenticated using (public.is_admin());
create policy admin_insert on public.orders for insert to authenticated with check (public.is_admin());
create policy admin_update on public.orders for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy admin_all on public.order_lines;
create policy admin_select on public.order_lines for select to authenticated using (public.is_admin());
create policy admin_insert on public.order_lines for insert to authenticated with check (public.is_admin());
create policy admin_update on public.order_lines for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Deletes an order for good. Items go back on the menu unless the order was already
-- picked up, archived, or canceled (canceled orders were restocked at the time).
create function public.delete_order(p_order_num int, p_passcode text) returns jsonb
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
     where l.order_num = o.order_num and m.drop_id = l.drop_id and m.item_id = l.item_id;
  end if;
  delete from public.orders where order_num = o.order_num;   -- its order_lines go with it
  return jsonb_build_object('ok', true, 'num', o.order_num);
end $$;

revoke execute on function public.delete_order(int, text) from public, anon;
grant execute on function public.delete_order(int, text) to authenticated;
