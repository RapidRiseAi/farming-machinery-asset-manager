-- 0481_supplier_links.sql
-- Pointing the two free-text columns at the record, without breaking anything that writes
-- them.
--
-- 0480 created the record. This migration is the harder half: `partner_expenses` and
-- `purchase_orders` are written from several places — the capture form, the purchase-order
-- conversion (0475), the demo seed, an import — and a change that required every one of
-- them to be updated in the same commit would have left whichever one was missed silently
-- creating unlinked rows again. So the link is added in a way that does not depend on the
-- caller knowing about it.
--
-- ── The resolution trigger is the load-bearing piece ─────────────────────────
--
-- A row arrives carrying a supplier NAME and no supplier id. Before it is stored, the name
-- is matched — trimmed and case-insensitively — against this workshop's suppliers, and the
-- id is filled in if there is one. That means:
--
--   * every existing writer keeps working unchanged and still ends up linked;
--   * the picker on the capture form is a convenience, not a requirement. Somebody typing
--     "agri diesel" into a form that has never heard of supplier ids gets the same row as
--     somebody choosing Agri Diesel from a list.
--
-- What it deliberately does NOT do is CREATE a supplier. Auto-creating on an unknown name
-- would put the typo back — every misspelling would mint a real record instead of a
-- phantom string, which is the same problem wearing a better coat, and it would do it
-- silently at the moment somebody is least likely to notice. An unmatched name simply
-- stays free text, exactly as it is today, and the creditors report (0482) falls back to
-- grouping it by the trimmed name. Filing the supplier is a decision a person makes.
--
-- ── Why the composite foreign key ───────────────────────────────────────────
--
-- `(supplier_id, workshop_id)` references `suppliers(id, workshop_id)`, so an expense can
-- only ever point at a supplier of its OWN workshop. RLS already stops one partner READING
-- another's suppliers; the foreign key makes the cross-workshop write structurally
-- impossible rather than merely unreachable through the screens — the same argument 0475
-- makes for the purchase-order link. MATCH SIMPLE (the default) means the constraint
-- stands down while `supplier_id` is null, which is the ordinary case for a supplier
-- nobody has filed.

alter table partner_expenses add column supplier_id uuid;
alter table purchase_orders  add column supplier_id uuid;

alter table partner_expenses
  add constraint partner_expenses_supplier_fk foreign key (supplier_id, workshop_id)
    references suppliers(id, workshop_id);
alter table purchase_orders
  add constraint purchase_orders_supplier_fk foreign key (supplier_id, workshop_id)
    references suppliers(id, workshop_id);

-- "What have I bought from this one, and what is still owed?" is the question the whole
-- feature exists to answer, so both sides get an index for it rather than a scan.
create index partner_expenses_supplier_idx on partner_expenses (supplier_id, expense_date desc)
  where supplier_id is not null and deleted_at is null;
create index purchase_orders_supplier_idx on purchase_orders (supplier_id, order_date desc)
  where supplier_id is not null and deleted_at is null;

comment on column partner_expenses.supplier_id is
  'The supplier record this expense was bought from (G18, 0480). Filled automatically from '
  'supplier_name by app_resolve_supplier() when a record of that name exists; left null '
  'when nobody has filed the supplier, in which case supplier_name still stands alone.';
comment on column purchase_orders.supplier_id is
  'The supplier record this order went to (G18, 0480). Same automatic resolution from '
  'supplier_name as partner_expenses.';

-- ── Resolution ───────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER (the default) rather than definer, on purpose. The lookup is confined
-- to `new.workshop_id` and the row itself cannot be written unless RLS already agrees the
-- caller owns that workshop, so a definer would buy nothing — while an invoker guarantees
-- the trigger can never surface a name from a workshop the writer is not allowed to read.
-- `search_path` is pinned regardless, because a trigger runs with whatever the caller's
-- path happened to be.
create or replace function app_resolve_supplier() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- A CORRECTED NAME must drop a stale link. If the name changed and the id did not, the
  -- writer was editing free text and knows nothing about supplier ids; keeping the old id
  -- would leave the row filed under a supplier it no longer names, and the ageing would
  -- quietly report money owed to the wrong business. Clearing it here means the lookup
  -- below either finds the new supplier or leaves the row unlinked — both honest.
  if tg_op = 'UPDATE'
     and new.supplier_id is not distinct from old.supplier_id
     and lower(btrim(coalesce(new.supplier_name, '')))
         is distinct from lower(btrim(coalesce(old.supplier_name, ''))) then
    new.supplier_id := null;
  end if;

  if new.supplier_id is null and coalesce(btrim(new.supplier_name), '') <> '' then
    -- At most one row can match: `suppliers_name_uq` is unique on exactly this expression
    -- among live rows. The explicit limit is there so a future relaxation of that index
    -- cannot turn this into a silently arbitrary choice that also raises TOO_MANY_ROWS.
    select s.id into new.supplier_id
      from suppliers s
     where s.workshop_id = new.workshop_id
       and s.deleted_at is null
       and lower(btrim(s.name)) = lower(btrim(new.supplier_name))
     order by s.created_at
     limit 1;

  elsif new.supplier_id is not null and coalesce(btrim(new.supplier_name), '') = '' then
    -- The other direction: a caller that knows the id and left the name blank. The name
    -- is what every existing screen, CSV and PDF prints, so it is filled from the record
    -- rather than left empty for a reader to puzzle over.
    select s.name into new.supplier_name
      from suppliers s
     where s.id = new.supplier_id and s.workshop_id = new.workshop_id;
  end if;

  return new;
end $$;

comment on function app_resolve_supplier() is
  'Links partner_expenses/purchase_orders to a suppliers row by trimmed, case-insensitive '
  'name (G18, 0481). Never CREATES a supplier — a typo must not mint a record — and drops '
  'the link when the name is edited away from it.';

create trigger partner_expenses_supplier before insert or update on partner_expenses
  for each row execute function app_resolve_supplier();
create trigger purchase_orders_supplier before insert or update on purchase_orders
  for each row execute function app_resolve_supplier();

-- ── Backfill ─────────────────────────────────────────────────────────────────
--
-- Everything captured before today is free text, and leaving it that way would mean the
-- feature only works for invoices captured from now on — which is precisely the history a
-- payables report is read for.
--
-- Written as a re-runnable FUNCTION rather than as bare statements for two reasons: it is
-- asserted twice in the isolation suite (running it again must create nothing), and a
-- partner who files a supplier today has three years of invoices that should attach to it,
-- so "run it again" is an ordinary operation rather than a one-off migration step.
--
-- SECURITY INVOKER, so RLS decides what it may touch. Called here by the migration role
-- (which bypasses RLS) it covers every workshop; called later by a partner it covers only
-- their own rows, which is the safe direction for a routine that rewrites data.
create or replace function app.link_suppliers()
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_created  bigint := 0;
  v_expenses bigint := 0;
  v_orders   bigint := 0;
begin
  -- One supplier per distinct name per workshop, from both sides at once, so a supplier
  -- known only to the order book is filed too. Names differing only in case or padding
  -- collapse to one record — that collapse IS the feature — and `min(btrim(name))` picks
  -- the spelling deterministically rather than by whichever row the planner reached first.
  with wanted as (
    select workshop_id, lower(btrim(supplier_name)) as key, min(btrim(supplier_name)) as name
      from (
        select workshop_id, supplier_name from partner_expenses
         where deleted_at is null and coalesce(btrim(supplier_name), '') <> ''
        union all
        select workshop_id, supplier_name from purchase_orders
         where deleted_at is null and coalesce(btrim(supplier_name), '') <> ''
      ) src
     group by workshop_id, lower(btrim(supplier_name))
  )
  insert into suppliers (workshop_id, name)
  select w.workshop_id, w.name
    from wanted w
   -- NOT EXISTS rather than ON CONFLICT: it is the same guarantee stated in a way that is
   -- true even where a soft-deleted record of that name is sitting outside the partial
   -- unique index, and it makes the second run visibly a no-op instead of a swallowed
   -- conflict.
   where not exists (
     select 1 from suppliers s
      where s.workshop_id = w.workshop_id
        and s.deleted_at is null
        and lower(btrim(s.name)) = w.key
   );
  get diagnostics v_created = row_count;

  -- The link itself. Only rows that have none are touched, so a second run updates
  -- nothing; anything already pointing somewhere was pointed there on purpose.
  update partner_expenses e
     set supplier_id = s.id
    from suppliers s
   where e.supplier_id is null
     and e.deleted_at is null
     and s.workshop_id = e.workshop_id
     and s.deleted_at is null
     and lower(btrim(s.name)) = lower(btrim(coalesce(e.supplier_name, '')));
  get diagnostics v_expenses = row_count;

  update purchase_orders o
     set supplier_id = s.id
    from suppliers s
   where o.supplier_id is null
     and o.deleted_at is null
     and s.workshop_id = o.workshop_id
     and s.deleted_at is null
     and lower(btrim(s.name)) = lower(btrim(coalesce(o.supplier_name, '')));
  get diagnostics v_orders = row_count;

  return jsonb_build_object(
    'suppliers_created', v_created,
    'expenses_linked',   v_expenses,
    'orders_linked',     v_orders
  );
end $$;

comment on function app.link_suppliers() is
  'Files a supplier record per distinct supplier_name per workshop and links the existing '
  'expenses and purchase orders to it (G18, 0481). Idempotent: a second run creates and '
  'links nothing. SECURITY INVOKER, so a partner calling it can only ever touch their own '
  'rows.';

select app.link_suppliers();

-- app.* is helper-only and never anon (G11: a function with no explicit grant defaults to
-- EXECUTE TO PUBLIC). No public wrapper is created — this is maintenance, not an API, so
-- PostgREST never sees it at all.
do $do$
declare f text;
begin
  foreach f in array array['app.link_suppliers()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
