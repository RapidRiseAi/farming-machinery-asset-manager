-- 0451_low_stock_nudge.sql
-- "You are down to two, and you set three as your minimum."
--
-- 0450 made the shelf countable. This makes it speak up, on the 0205 engine pattern that
-- service dues, expiries, fuel anomalies and outstanding quotes already use: a
-- SECURITY DEFINER function in `app`, execute revoked from everyone but the service role,
-- a `public.cron_*` wrapper for the nightly route, quiet hours honoured, and a weekly
-- dedupe read from the notification queue itself rather than a new column on the row
-- (the F13 approach — a dedupe column is a second thing to keep in step).

-- ── What counts as "low" ─────────────────────────────────────────────────────
-- Deliberately its own function rather than a predicate buried in the engine's WHERE
-- clause, because this is the part most likely to want changing once a real farm has used
-- it for a season, and it should be changeable in one place without touching the machinery
-- around it.
--
-- The rule today is the plain one: at or below the minimum you set, and only where you set
-- one. A part with no reorder_point is not "low at zero" — it is untracked, and inventing
-- a threshold for it would produce a nightly nudge nobody asked for, which is how people
-- learn to ignore notifications.
--
-- The obvious next version is COMMITMENT-AWARE and needs no new tables: service_kit_items
-- (0271) already says what each service consumes, and app.recalc_machine_service (0202)
-- already knows which services fall due. "You have 2 filters and the 250-hour service due
-- next week needs 6" is a materially better sentence than "you have 2 and your minimum is
-- 3", because it names the consequence rather than the threshold. Left out here on
-- purpose: it is a judgement about how far ahead to look that is better made by somebody
-- who has run a farm store than guessed at now.
create or replace function app.stock_needs_reorder(p_on_hand numeric, p_reorder_point numeric)
returns boolean
language sql immutable as $$
  select p_reorder_point is not null and p_on_hand <= p_reorder_point;
$$;

-- app.* is helper-only: a function with no explicit grant defaults to EXECUTE TO PUBLIC,
-- which is how the F14 debug probe stayed reachable (0440). The G11 assertion in
-- rls_isolation.sql caught this one the first time the suite ran.
revoke execute on function app.stock_needs_reorder(numeric, numeric) from public, anon;
grant  execute on function app.stock_needs_reorder(numeric, numeric) to authenticated, service_role;

comment on function app.stock_needs_reorder(numeric, numeric) is
  'Whether a stock item should be reordered. Single point of change for the rule; see '
  '0451 header for the commitment-aware version that service kits would allow.';

-- ── The engine ───────────────────────────────────────────────────────────────
create or replace function app.enqueue_low_stock_nudges() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_deliver_after timestamptz;
begin
  for r in
    select si.id, si.farm_id, si.on_hand, si.reorder_point, si.unit, si.bin,
           pc.part_no, pc.description, pc.supplier, f.settings
    from stock_items si
    join parts_catalogue pc on pc.id = si.part_catalogue_id
    join farms f on f.id = si.farm_id
    where si.deleted_at is null
      and pc.deleted_at is null
      and f.deleted_at is null
      -- A farm that has stopped paying is not chased about filters.
      and f.status in ('trial', 'active')
      and app.stock_needs_reorder(si.on_hand, si.reorder_point)
  loop
    -- Weekly re-fire, read from the queue. A shelf that is low stays low until somebody
    -- buys something, and a nightly repeat of the same line is how an alert centre becomes
    -- wallpaper.
    if exists (
      select 1 from notifications n
      where n.farm_id  = r.farm_id
        and n.template = 'low_stock'
        and n.payload->>'stock_item_id' = r.id::text
        and n.created_at > now() - interval '7 days'
    ) then
      continue;
    end if;

    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'low_stock', jsonb_build_object(
      'stock_item_id', r.id,
      'part_no',       r.part_no,
      'description',   r.description,
      'supplier',      r.supplier,
      'on_hand',       r.on_hand,
      'reorder_point', r.reorder_point,
      'unit',          r.unit,
      'bin',           r.bin
    ), v_deliver_after);
  end loop;
end $$;

-- ── Lock down the engine (0205 pattern) ──────────────────────────────────────
revoke execute on function app.enqueue_low_stock_nudges() from public, anon, authenticated;
grant  execute on function app.enqueue_low_stock_nudges() to service_role;

-- ── PostgREST-callable cron wrapper ──────────────────────────────────────────
create or replace function public.cron_enqueue_low_stock() returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.enqueue_low_stock_nudges();
$$;
revoke execute on function public.cron_enqueue_low_stock() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_low_stock() to service_role;
