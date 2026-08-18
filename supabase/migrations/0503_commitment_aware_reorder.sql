-- 0503_commitment_aware_reorder.sql
-- "You have 2 filters and the 250-hour service due next week needs 6."
--
-- 0451 shipped the plain rule — `app.stock_needs_reorder(on_hand, reorder_point)`, at or
-- below the minimum you set — and said in its own header that the next version was
-- commitment-aware and needed no new tables. It does not: `service_kit_items` (0271)
-- already says what a service consumes, `app.recalc_machine_service` (0202) already knows
-- what falls due, and `stock_items` (0450) already knows what is on the shelf. This joins
-- the three. **No new table is added by this migration.**
--
-- The difference is not cosmetic. "You have 2 and your minimum is 3" names a threshold
-- somebody typed; "the next 30 days need 6 and you have 2" names a CONSEQUENCE, and it
-- fires for a part that has no reorder point at all — which is most of them, because
-- setting a minimum for every part in a store is work nobody does.
--
-- ── The lookahead is a judgement, so it is a SETTING ────────────────────────────
--
-- 0451 declined to guess how far ahead to look. Guessing it in a function body would be
-- worse than guessing it badly: nobody could see the number, and nobody could change it.
-- So it is `farms.settings.reorder_lookahead_days`, written through the existing
-- owner/manager-guarded `update_farm_settings` RPC (0204, jsonb `||` merge — no schema
-- change, no new policy), default **30 days**, and the screen states the window in words.
-- Clamped to 1..365 on READ, so a typo of 100000 cannot produce a nonsense projection and
-- a farm that has already stored one is not stuck with it.
--
-- ── When does a service "fall due inside the window"? ───────────────────────────
--
-- Three ways, and it is worth being explicit because each covers a case the others miss:
--
--   1. `status in ('due_soon','overdue')` — the 0202 due engine has already ruled. This is
--      the authority, not a second opinion; anything it flags is in the window whatever the
--      arithmetic below says.
--   2. Calendar basis: `next_due_date <= current_date + days`. Exact arithmetic, no model.
--   3. Meter basis: the machine's OBSERVED daily rate, projected over the window.
--
-- (3) needs a rate, and the choice of where it comes from matters. The farm already has
-- `utilisation_hours_per_day` / `_km_per_day` (G1) — but those are CAPACITY, an upper
-- bound. At the 10 h/day default every 250-hour service on every machine is "due within 30
-- days" for ever, which is a screen where everything is red and therefore a screen nobody
-- reads. So the rate is OBSERVED: the meter movement over the trailing 90 days divided by
-- the days between the first and last reading in it. A machine parked all winter projects
-- nothing, which is correct.
--
-- Where there is not enough history to observe a rate — fewer than two readings, or less
-- than a week between them — NOTHING is invented. Such a line reaches the window only via
-- (1) or (2). That is the honest answer: we do not know how fast this machine is used, and
-- a made-up rate would put a number on the screen that no farmer could account for.
--
-- ── A machine's kit counts ONCE, and all of its kits count ──────────────────────
--
-- Nothing in the schema links a `service_kit` to a `service_plan_line`. A kit is scoped to
-- a machine or to a machine_type; a plan line is a task with an interval. So two questions
-- have to be answered by convention, and both are answered in the direction of the store:
--
--   * Several lines due on one machine → the kit counts ONCE. Three tasks falling due
--     together are one service visit, and counting the kit three times would treble the
--     number.
--   * Several kits on one machine (a 250 h kit and a 500 h kit) → ALL of them count. There
--     is no data that says which service a kit belongs to, so the alternative is to pick one
--     arbitrarily. Over-warning on a reorder screen fails safe — you buy a filter you will
--     need next quarter — and `stock_commitment` returns the contributing machines and kits
--     so the number is auditable rather than mysterious. The screen says this in words.
--
-- A machine with no kit of its own falls back to a kit template for its TYPE. A machine
-- with its own kit ignores the type template, so the two never stack.
--
-- ── Matching a kit item to the shelf ───────────────────────────────────────────
--
-- By catalogue part where the kit item links one; otherwise by the part NUMBER, compared
-- trimmed and case-insensitively, exactly the way 0482 resolves a supplier from free text.
-- A kit item that carries both is matched by its catalogue id only, so it cannot count
-- twice. A committed part the farm does not track in the store yields no row — there is no
-- shelf to be short of. That is a known limit, recorded rather than hidden.
--
-- ── Warn, never block ──────────────────────────────────────────────────────────
--
-- Nothing here refuses anything. There is no trigger, no constraint and no check on
-- `stock_movements` or `job_card_lines` in this file: a mechanic at six in the morning must
-- be able to issue the last filter and record reality. Same call 0430 made for missing
-- receipts and 0500 for a credit limit — the product says so, loudly, and gets out of the
-- way.
--
-- Reading stays open to the whole farm side and writing stays owner/manager/mechanic:
-- these are read-only functions over tables whose policies 0452 already settled, and
-- nothing below re-opens that.

-- ── The window ───────────────────────────────────────────────────────────────
-- Its own function for the same reason `stock_needs_reorder` is: this is the part most
-- likely to want changing once a real farm has used it for a season.
create or replace function app.reorder_lookahead_days(p_farm uuid) returns int
language sql stable security invoker set search_path = public, pg_temp as $$
  select greatest(1, least(365, coalesce(
           (select nullif(f.settings->>'reorder_lookahead_days', '')::int
              from farms f where f.id = p_farm),
           30)));
$$;

comment on function app.reorder_lookahead_days(uuid) is
  'How far ahead the store looks for committed parts: farms.settings.reorder_lookahead_days, '
  'default 30, clamped to 1..365 on read. Set through update_farm_settings (0204).';

-- ── What the next N days have already spoken for ─────────────────────────────
-- SECURITY INVOKER on purpose (the 0460 rule): passing another farm's id is answered by RLS
-- on stock_items / service_plan_lines / machines / service_kits, not by a check somebody
-- could forget to write. Every `deleted_at is null` is stated anyway, because the nightly
-- engine runs as a role that bypasses those policies.
create or replace function app.stock_commitment(p_farm uuid, p_days int default null)
returns table (
  stock_item_id     uuid,
  part_catalogue_id uuid,
  part_no           text,
  unit              text,
  committed_qty     numeric,
  machine_count     int,
  sources           jsonb
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with win as (
    -- `coalesce(greatest(1, least(365, p_days)), …)` would be wrong: least/greatest IGNORE
    -- nulls in Postgres, so a null p_days would come back as 365 and never reach the
    -- setting. An explicit CASE says what is meant.
    select case
             when p_days is null then app.reorder_lookahead_days(p_farm)
             else greatest(1, least(365, p_days))
           end as days
  ),
  -- The OBSERVED daily meter rate. max(reading) - min(reading) over the trailing 90 days,
  -- across the days actually spanned by those two readings. A replaced or reset meter
  -- overstates here, which errs towards warning early.
  rate as (
    select mr.machine_id,
           (max(mr.reading) - min(mr.reading))
             / greatest(max(mr.reading_date) - min(mr.reading_date), 1)::numeric as per_day
      from meter_readings mr
     where mr.farm_id = p_farm
       and mr.deleted_at is null
       and mr.reading_date >= current_date - 90
       and mr.reading_date <= current_date
     group by mr.machine_id
    having count(*) >= 2
       and max(mr.reading_date) - min(mr.reading_date) >= 7
  ),
  -- One row per machine with at least one service falling due inside the window. Retired
  -- and sold machines are excluded, like every other engine (Scope §4.1 / C8).
  due_machines as (
    select distinct spl.machine_id, m.type as machine_type, m.name as machine_name
      from service_plan_lines spl
      join machines m on m.id = spl.machine_id
      left join rate r on r.machine_id = spl.machine_id
     cross join win w
     where spl.farm_id = p_farm
       and spl.deleted_at is null
       and m.deleted_at is null
       and m.status not in ('retired', 'sold')
       and (
            spl.status in ('due_soon', 'overdue')
         or (spl.next_due_date is not null and spl.next_due_date <= current_date + w.days)
         or (spl.next_due_reading is not null
             and m.meter_type in ('hours', 'km')
             and m.current_reading is not null
             and r.per_day is not null
             and m.current_reading + (r.per_day * w.days) >= spl.next_due_reading)
       )
  ),
  -- The machine's own kits, or its type's templates when it has none of its own.
  kits as (
    select k.id as kit_id, k.name as kit_name, dm.machine_id, dm.machine_name
      from due_machines dm
      join service_kits k
        on k.farm_id = p_farm
       and k.deleted_at is null
       and (
            k.machine_id = dm.machine_id
         or (k.machine_id is null
             and k.machine_type = dm.machine_type
             and not exists (
               select 1 from service_kits own
                where own.farm_id = p_farm
                  and own.deleted_at is null
                  and own.machine_id = dm.machine_id))
       )
  ),
  items as (
    select k.machine_id, k.machine_name, k.kit_name,
           si.id as stock_item_id, si.part_catalogue_id, si.unit,
           pc.part_no, ski.qty
      from kits k
      join service_kit_items ski
        on ski.service_kit_id = k.kit_id and ski.deleted_at is null
      join stock_items si
        on si.farm_id = p_farm and si.deleted_at is null
      left join parts_catalogue pc
        on pc.id = si.part_catalogue_id and pc.deleted_at is null
     where (ski.part_catalogue_id is not null
            and si.part_catalogue_id = ski.part_catalogue_id)
        or (ski.part_catalogue_id is null
            and nullif(btrim(ski.part_no), '') is not null
            and lower(btrim(ski.part_no)) = lower(btrim(coalesce(pc.part_no, ''))))
  )
  select i.stock_item_id,
         i.part_catalogue_id,
         i.part_no,
         i.unit,
         sum(i.qty)::numeric,
         count(distinct i.machine_id)::int,
         jsonb_agg(jsonb_build_object(
           'machine_id', i.machine_id,
           'machine',    i.machine_name,
           'kit',        i.kit_name,
           'qty',        i.qty
         ) order by i.machine_name, i.kit_name)
    from items i
   group by i.stock_item_id, i.part_catalogue_id, i.part_no, i.unit;
$$;

comment on function app.stock_commitment(uuid, int) is
  'Per stock item, the quantity spoken for by services falling due inside the farm''s '
  'lookahead window (0503). No new tables: service_kit_items x the 0202 due engine. A '
  'machine''s kit counts once; a machine with several kits counts all of them, and the '
  'contributing machines/kits are returned so the number can be audited.';

-- ── On hand, committed, and what is missing ──────────────────────────────────
-- Built FROM stock_commitment rather than repeating its joins, so the two can never
-- disagree — the same reason `app.partner_cashflow` is built from its own item list (0486).
create or replace function app.stock_shortfall(p_farm uuid, p_days int default null)
returns table (
  stock_item_id  uuid,
  part_no        text,
  description    text,
  unit           text,
  bin            text,
  on_hand        numeric,
  reorder_point  numeric,
  committed_qty  numeric,
  projected_qty  numeric,
  short_qty      numeric,
  is_short       boolean,
  needs_reorder  boolean,
  machine_count  int,
  sources        jsonb
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select si.id,
         pc.part_no,
         pc.description,
         si.unit,
         si.bin,
         si.on_hand,
         si.reorder_point,
         coalesce(c.committed_qty, 0)::numeric,
         (si.on_hand - coalesce(c.committed_qty, 0))::numeric,
         -- Guarded by the same condition as is_short below, so the two cannot disagree.
         -- Without it a shelf at -2 with NOTHING committed reports "2 short" while
         -- is_short says false, and any caller that trusted the number rather than the
         -- flag would send somebody to buy a part no service is waiting on.
         (case when coalesce(c.committed_qty, 0) > 0
                 then greatest(coalesce(c.committed_qty, 0) - si.on_hand, 0)
                 else 0 end)::numeric,
         -- A shelf below zero with NOTHING committed is a counting error (0450 allows it on
         -- purpose so it can be seen and fixed), not a commitment shortfall. Saying "short"
         -- about it would send somebody to buy a part they may already have.
         (coalesce(c.committed_qty, 0) > 0 and si.on_hand < coalesce(c.committed_qty, 0)),
         app.stock_needs_reorder(si.on_hand, si.reorder_point),
         coalesce(c.machine_count, 0),
         coalesce(c.sources, '[]'::jsonb)
    from stock_items si
    -- LEFT, so a stock item never disappears from a reorder report because its catalogue
    -- row was soft-deleted. A missing part number is the app's problem to render, not a
    -- reason to lose the count.
    left join parts_catalogue pc
      on pc.id = si.part_catalogue_id and pc.deleted_at is null
    left join app.stock_commitment(p_farm, p_days) c
      on c.stock_item_id = si.id
   where si.farm_id = p_farm
     and si.deleted_at is null
   order by (si.on_hand - coalesce(c.committed_qty, 0)) asc, pc.part_no;
$$;

comment on function app.stock_shortfall(uuid, int) is
  'On hand vs committed vs short, per stock item (0503). Built from app.stock_commitment so '
  'the screen and the nightly nudge cannot disagree. Warns; never blocks anything.';

-- ── PostgREST-callable wrappers ──────────────────────────────────────────────
-- PostgREST exposes only `public`, and the app needs both of these to render the store.
-- SECURITY INVOKER all the way down, so RLS is what answers a cross-tenant id.
create or replace function public.reorder_lookahead_days(p_farm uuid) returns int
language sql stable security invoker set search_path = public, pg_temp as $$
  select app.reorder_lookahead_days(p_farm);
$$;

create or replace function public.stock_commitment(p_farm uuid, p_days int default null)
returns table (
  stock_item_id uuid, part_catalogue_id uuid, part_no text, unit text,
  committed_qty numeric, machine_count int, sources jsonb
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.stock_commitment(p_farm, p_days);
$$;

create or replace function public.stock_shortfall(p_farm uuid, p_days int default null)
returns table (
  stock_item_id uuid, part_no text, description text, unit text, bin text,
  on_hand numeric, reorder_point numeric, committed_qty numeric, projected_qty numeric,
  short_qty numeric, is_short boolean, needs_reorder boolean, machine_count int, sources jsonb
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.stock_shortfall(p_farm, p_days);
$$;

-- A function with no explicit grant defaults to EXECUTE TO PUBLIC — how the F14 debug probe
-- stayed reachable (0440), and what G11 fails the suite for.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.reorder_lookahead_days(uuid)',
    'app.stock_commitment(uuid,int)',
    'app.stock_shortfall(uuid,int)',
    'public.reorder_lookahead_days(uuid)',
    'public.stock_commitment(uuid,int)',
    'public.stock_shortfall(uuid,int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant  execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;

-- ── The nudge ────────────────────────────────────────────────────────────────
-- 0205 pattern, exactly as 0451: SECURITY DEFINER in `app`, execute revoked from everyone
-- but the service role, a `public.cron_*` wrapper for the nightly route, quiet hours
-- honoured, and a weekly dedupe read from the notification QUEUE rather than from a new
-- column (F13's approach — a dedupe column is a second thing to keep in step).
create or replace function app.enqueue_stock_shortfall_nudges() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f               record;
  r               record;
  v_days          int;
  v_deliver_after timestamptz;
begin
  for f in
    select id, settings from farms
     where deleted_at is null
       -- A farm that has stopped paying is not chased about filters.
       and status in ('trial', 'active')
  loop
    v_days := app.reorder_lookahead_days(f.id);
    for r in select * from app.stock_shortfall(f.id, v_days) where is_short loop
      if exists (
        select 1 from notifications n
        where n.farm_id  = f.id
          and n.template = 'stock_short'
          and n.payload->>'stock_item_id' = r.stock_item_id::text
          and n.created_at > now() - interval '7 days'
      ) then
        continue;                                  -- already said this week
      end if;

      v_deliver_after := app.quiet_deliver_after(f.settings);
      perform app.notify_farm(f.id, 'stock_short', jsonb_build_object(
        'stock_item_id', r.stock_item_id,
        'part_no',       r.part_no,
        'description',   r.description,
        'unit',          r.unit,
        'on_hand',       r.on_hand,
        'committed',     r.committed_qty,
        'short',         r.short_qty,
        'machines',      r.machine_count,
        'days',          v_days
      ), v_deliver_after);
    end loop;
  end loop;
end $$;

revoke execute on function app.enqueue_stock_shortfall_nudges() from public, anon, authenticated;
grant  execute on function app.enqueue_stock_shortfall_nudges() to service_role;

create or replace function public.cron_enqueue_stock_shortfall() returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.enqueue_stock_shortfall_nudges();
$$;
revoke execute on function public.cron_enqueue_stock_shortfall() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_stock_shortfall() to service_role;

-- ── One shelf, one sentence a week ───────────────────────────────────────────
-- 0451's engine is REPLACED rather than left alongside, because an item that is both below
-- its minimum AND short would otherwise raise two notifications about the same shelf on the
-- same night — and two lines that say nearly the same thing is how an alert centre becomes
-- wallpaper, which is the exact failure 0451's own header warned about.
--
-- Where both apply the shortfall wins: it names the consequence and the low-stock line only
-- names the threshold. Where only one applies, that one fires. The suppression is computed
-- once up front rather than per row, and it makes the two engines order-independent in the
-- nightly route — whichever runs first, an item gets at most one message.
--
-- Everything else about this function is 0451 unchanged.
create or replace function app.enqueue_low_stock_nudges() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_deliver_after timestamptz;
  v_short         uuid[];
begin
  select coalesce(array_agg(sf.stock_item_id), '{}'::uuid[])
    into v_short
    from farms f
   cross join lateral app.stock_shortfall(f.id) sf
   where f.deleted_at is null
     and f.status in ('trial', 'active')
     and sf.is_short;

  for r in
    select si.id, si.farm_id, si.on_hand, si.reorder_point, si.unit, si.bin,
           pc.part_no, pc.description, pc.supplier, f.settings
    from stock_items si
    join parts_catalogue pc on pc.id = si.part_catalogue_id
    join farms f on f.id = si.farm_id
    where si.deleted_at is null
      and pc.deleted_at is null
      and f.deleted_at is null
      and f.status in ('trial', 'active')
      and app.stock_needs_reorder(si.on_hand, si.reorder_point)
  loop
    -- The better sentence is coming from the shortfall engine; do not say it twice.
    if r.id = any (v_short) then
      continue;
    end if;

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

-- `create or replace` keeps existing privileges, but they are re-stated rather than
-- assumed: G11 fails the suite for any app-schema function anon can execute, and "it was
-- already correct" is not something a migration should take on trust.
revoke execute on function app.enqueue_low_stock_nudges() from public, anon, authenticated;
grant  execute on function app.enqueue_low_stock_nudges() to service_role;

comment on function app.enqueue_low_stock_nudges() is
  'The 0451 low-stock nudge, with items that the 0503 shortfall engine is about to speak '
  'about suppressed so a shelf raises one sentence a week, not two.';
