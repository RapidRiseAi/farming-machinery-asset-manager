-- 0452_store_writes_are_role_gated.sql
-- Who may change the count, enforced where it holds.
--
-- Found by driving 0450 rather than by reading it. The server actions in
-- `parts/stock-actions.ts` guard every write with
-- `requireRole(["owner","manager","mechanic"])`, so the screen behaves correctly — but the
-- 0450 policies only asked for `app.has_farm_access(farm_id) and app.is_farm_side()`,
-- which admits an OPERATOR. Signed in as the demo driver and querying the REST endpoint
-- directly returned the store and its movements, and nothing in the database would have
-- stopped that session writing a movement and moving a machine's costs with it.
--
-- That is precisely the shape F7 was written to rule out: "per-role visibility enforced in
-- RLS, not just the UI". A server action is a door, and this schema's rule is that the
-- lock is on the table.
--
-- READING stays open to the whole farm side, deliberately. "Have we got a filter?" is a
-- fair question for a driver standing at the shed at six in the morning, the catalogue it
-- joins to is already readable by every farm role, and a store nobody can consult is a
-- store people work around. It is the WRITE that decides what a machine costs, so it is
-- the write that narrows — to the same three roles that maintain the parts catalogue.

do $do$
declare t text;
begin
  foreach t in array array['stock_items','stock_movements'] loop
    execute format('drop policy %1$I_ins on public.%1$I', t);
    execute format('drop policy %1$I_upd on public.%1$I', t);
    execute format('drop policy %1$I_del on public.%1$I', t);

    execute format($p$
      create policy %1$I_ins on public.%1$I for insert to authenticated
      with check (app.has_farm_access(farm_id) and app.is_farm_side()
                  and app.current_app_role() in ('owner','manager','mechanic'))
    $p$, t);
    execute format($p$
      create policy %1$I_upd on public.%1$I for update to authenticated
      using (app.has_farm_access(farm_id) and app.is_farm_side()
             and app.current_app_role() in ('owner','manager','mechanic'))
      with check (app.has_farm_access(farm_id) and app.is_farm_side()
                  and app.current_app_role() in ('owner','manager','mechanic'))
    $p$, t);
    execute format($p$
      create policy %1$I_del on public.%1$I for delete to authenticated
      using (app.has_farm_access(farm_id) and app.is_farm_side()
             and app.current_app_role() in ('owner','manager','mechanic'))
    $p$, t);
  end loop;
end $do$;
