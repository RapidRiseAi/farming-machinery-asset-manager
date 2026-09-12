-- 20260912140000_supplier_pick_collation_independent.sql
-- The "deterministic pick" was decided by the database's collation.
--
-- WHAT WAS WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.link_suppliers()` (0481) collapses every spelling of one business into a single
-- supplier record and chooses the canonical name with `min(btrim(supplier_name))`. 0481's
-- own comment calls that a deterministic pick. It is not deterministic at all: `min()` on
-- text sorts by the DATABASE's collation, so the same two rows file different records:
--
--     C collation        ->  'Agri Diesel'    (byte order, 'A' 0x41 before 'a' 0x61)
--     en_US.UTF-8 / ICU  ->  'agri diesel'
--
-- Production is `en_US.UTF-8`. So is CI. A developer on a C-collation database gets the
-- other answer, and the supplier record that ends up on a remittance advice depends on
-- where the backfill happened to run.
--
-- HOW IT WAS FOUND
-- ─────────────────────────────────────────────────────────────────────────────
-- CI's "RLS isolation tests" job had been failing on EVERY commit for over a week with
--
--     G18 FAIL: the filed record is named agri diesel, not the deterministic pick
--
-- and nobody could see it, because the job logs need repository admin rights. It was
-- reproduced locally by building the test database with an ICU `en-US` locale instead of
-- the default, which is the only difference that matters here — under the default `C`
-- collation every suite passes and the bug is invisible.
--
-- THE FIX, AND WHY THIS DIRECTION
-- ─────────────────────────────────────────────────────────────────────────────
-- `collate "C"` makes the tie-break byte order, which is the same on every database
-- anywhere. It also picks the better record: given 'Agri Diesel' and 'agri diesel' it keeps
-- the properly capitalised spelling, and that is the one that gets printed on a remittance
-- advice and a purchase order.
--
-- This changes nothing that is already filed. `link_suppliers()` only inserts where no
-- record for that name-key exists yet, so existing suppliers keep their names; the rule
-- applies to businesses filed from here on.
--
-- The body below is EXTRACTED from the live definition and altered by one token.
-- Hand-transcribing a function body has gone wrong three times in this project.

CREATE OR REPLACE FUNCTION app.link_suppliers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    select workshop_id, lower(btrim(supplier_name)) as key, min(btrim(supplier_name) collate "C") as name
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
end $function$;
