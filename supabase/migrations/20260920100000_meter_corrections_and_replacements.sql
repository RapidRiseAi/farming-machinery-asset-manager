-- 20260920100000_meter_corrections_and_replacements.sql
-- Two things a farm could not do, and both of them trap the machine for good.
--
-- THE TRAP
-- ─────────────────────────────────────────────────────────────────────────────
-- `machines.current_reading` only ever moves forward: `app_meter_reading_after` (0202)
-- advances it on every reading, `record_meter_reading` (20260903074034) refuses a
-- current/newer reading below it, and the offline path turns one into a `conflict` that
-- "needs a person to resolve" (20260908112437). There was no such person, because there
-- was no action for them to use: nothing in the product updated or deleted a meter
-- reading, although the RLS policies for it have existed all along.
--
-- So one typo — 12500 where 1250 was meant — is permanent. Every true reading afterwards
-- is refused as a decrease, and every service due date computed from it is wrong, for the
-- life of the machine. The same wall stands in front of an ordinary event: an hour meter
-- or an instrument cluster that gets replaced, which on older tractors is routine.
--
-- TWO DIFFERENT EVENTS, DELIBERATELY KEPT APART
-- ─────────────────────────────────────────────────────────────────────────────
-- A CORRECTION says the reading never happened: somebody mistyped it. The row is voided
-- (soft delete, with a reason), and the machine falls back to what the remaining history
-- says. The audit trigger keeps the original values, so a correction is never a quiet edit.
--
-- A REPLACEMENT says the reading was true and the METER changed: the old hours belong to
-- the old instrument, and counting starts again. It is recorded as its own event, and
-- service plan lines are rebased by the difference so "next due at 1 500 hours" does not
-- become unreachable the moment a meter starts again at zero.
--
-- WHAT FOLLOWS FROM THAT
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.machine_effective_reading` is the single rule for "what does this machine read
-- now": the newest surviving reading taken on or after the last meter replacement, and
-- failing that, the replacement's own starting value. Both commands recompute from it, so
-- correcting a reading cannot resurrect a meter that has since been replaced.
--
-- KNOWN LIMITATION, written down rather than discovered later: consumption and utilisation
-- (litres per hour, hours used) compare consecutive readings and know nothing about
-- replacements. A machine that has had a meter changed will show one meaningless interval
-- across the change. Lifetime totals across a replacement are likewise not summed. Fixing
-- that means teaching the analytics about segments, which is a larger piece of work than
-- unblocking the farm.
--
-- WHERE THE WORK HAPPENS, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Every side effect — recomputing the machine, rebasing the plan, recalculating due dates
-- — happens in SECURITY DEFINER triggers, exactly as `app_meter_reading_after` (0202)
-- already does for an ordinary reading. That is not decoration: `app.recalc_machine_service`
-- is revoked from `authenticated`, so an invoker-rights function cannot call it, and
-- granting it would hand every signed-in user a cross-tenant recompute.
--
-- `record_meter_replacement` is SECURITY INVOKER and does one INSERT, so **RLS decides**
-- who may rebase a machine (`meter_replacements_ins`: owner / manager / Rapid Rise).
-- `correct_meter_reading` cannot be: see the note above it.

-- ── Why a reading was voided ────────────────────────────────────────────────
alter table public.meter_readings add column if not exists voided_reason text;
comment on column public.meter_readings.voided_reason is
  'Why this reading was corrected away. Set by public.correct_meter_reading; null for live rows.';

-- ── The replacement event ───────────────────────────────────────────────────
create table if not exists public.meter_replacements (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null,
  machine_id       uuid not null,
  replaced_on      date not null default current_date,
  -- What the old instrument read when it came off, and what the new one starts at. Both are
  -- kept: the difference is the offset between the machine's two lives, and it is the only
  -- way to read the history on either side of the change.
  previous_reading numeric(12,1),
  new_reading      numeric(12,1) not null,
  note             text,
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  constraint meter_replacements_new_reading_ck check (new_reading >= 0),
  constraint meter_replacements_machine_fk foreign key (machine_id, farm_id)
    references public.machines(id, farm_id),
  constraint meter_replacements_farm_fk foreign key (farm_id) references public.farms(id),
  constraint meter_replacements_id_farm_uq unique (id, farm_id)
);
create index if not exists meter_replacements_machine_idx
  on public.meter_replacements(machine_id, replaced_on desc);
create index if not exists meter_replacements_farm_idx on public.meter_replacements(farm_id);

alter table public.meter_replacements enable row level security;
alter table public.meter_replacements force  row level security;

drop policy if exists meter_replacements_sel on public.meter_replacements;
create policy meter_replacements_sel on public.meter_replacements for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null
         and app.row_visible_to_role(farm_id, machine_id));
-- Writing one is an office decision, exactly like correcting a reading: it moves every
-- service due date on the machine. Crew roles capture readings; they do not rebase them.
drop policy if exists meter_replacements_ins on public.meter_replacements;
create policy meter_replacements_ins on public.meter_replacements for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
drop policy if exists meter_replacements_upd on public.meter_replacements;
create policy meter_replacements_upd on public.meter_replacements for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
drop policy if exists meter_replacements_del on public.meter_replacements;
create policy meter_replacements_del on public.meter_replacements for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

grant select, insert, update, delete on public.meter_replacements to authenticated;
grant all on public.meter_replacements to service_role;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'meter_replacements_audit'
  ) then
    create trigger meter_replacements_audit
      after insert or update or delete on public.meter_replacements
      for each row execute function app_audit();
  end if;
end $$;

-- ── The one rule for "what does this machine read now" ───────────────────────
create or replace function app.machine_effective_reading(p_machine uuid)
returns table (reading numeric, reading_date date)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  with last_change as (
    select r.replaced_on, r.new_reading
      from public.meter_replacements r
     where r.machine_id = p_machine
       and r.deleted_at is null
     order by r.replaced_on desc, r.created_at desc
     limit 1
  ),
  surviving as (
    select mr.reading, mr.reading_date
      from public.meter_readings mr
     where mr.machine_id = p_machine
       and mr.deleted_at is null
       and mr.reading_date >= coalesce((select replaced_on from last_change), '-infinity'::date)
     order by mr.reading_date desc, mr.created_at desc
     limit 1
  )
  select coalesce((select reading from surviving), (select new_reading from last_change)),
         coalesce((select reading_date from surviving), (select replaced_on from last_change));
$$;

comment on function app.machine_effective_reading(uuid) is
  'The newest surviving reading on or after the machine''s last meter replacement, else the '
  'replacement''s own starting value. Both meter commands recompute from this.';

revoke execute on function app.machine_effective_reading(uuid) from public, anon;
grant execute on function app.machine_effective_reading(uuid) to authenticated, service_role;

-- ── The side effects, in triggers, with the rights to do them ───────────────
--
-- Both are SECURITY DEFINER for one reason: `app.recalc_machine_service` is revoked from
-- `authenticated` (0202). They run only as a consequence of a row the caller was already
-- allowed to write, so the authorisation still lives in RLS.

-- A voided reading: fall back to what the surviving history says, and recalculate.
create or replace function app_meter_reading_voided() returns trigger
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_reading numeric; v_date date;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    select er.reading, er.reading_date
      into v_reading, v_date
      from app.machine_effective_reading(new.machine_id) er;

    update public.machines
       set current_reading = v_reading,
           current_reading_date = v_date
     where id = new.machine_id
       and farm_id = new.farm_id;

    -- Every due date on this machine was computed from a reading that is now gone.
    perform app.recalc_machine_service(new.machine_id);
  end if;
  return new;
end $$;

drop trigger if exists meter_readings_voided on public.meter_readings;
create trigger meter_readings_voided
  after update on public.meter_readings
  for each row execute function app_meter_reading_voided();

revoke execute on function app_meter_reading_voided() from public, anon, authenticated;

-- A replaced meter: new baseline, and a schedule rebased by the size of the step.
create or replace function app_meter_replacement_after() returns trigger
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_delta numeric;
begin
  update public.machines
     set current_reading = new.new_reading,
         current_reading_date = new.replaced_on
   where id = new.machine_id
     and farm_id = new.farm_id;

  -- A line last done at 1 200 hours, on a meter that read 1 400 and now reads 0, was done
  -- 200 hours ago — so it is "done at −200", floored at zero. That is the honest reading of
  -- "it was already due when the meter changed", and what recalc then works from.
  v_delta := coalesce(new.previous_reading, new.new_reading) - new.new_reading;
  if v_delta <> 0 then
    update public.service_plan_lines
       set last_done_reading = greatest(last_done_reading - v_delta, 0)
     where machine_id = new.machine_id
       and farm_id = new.farm_id
       and deleted_at is null
       and last_done_reading is not null;
  end if;

  perform app.recalc_machine_service(new.machine_id);
  return new;
end $$;

drop trigger if exists meter_replacements_after on public.meter_replacements;
create trigger meter_replacements_after
  after insert on public.meter_replacements
  for each row execute function app_meter_replacement_after();

revoke execute on function app_meter_replacement_after() from public, anon, authenticated;

-- ── Correcting a reading ────────────────────────────────────────────────────
-- SECURITY DEFINER, and this one is not a preference.
--
-- Voiding a reading is an UPDATE that sets `deleted_at`, which makes the row invisible to
-- `meter_readings_sel` — and Postgres refuses an update whose new row the caller could no
-- longer see ("new row violates row-level security policy"). Measured, not assumed: adding
-- a permissive SELECT policy makes the identical statement succeed.
--
-- So the authorisation cannot be left to RLS here and is written out instead, in the same
-- order RLS would have applied it: authenticated, a role of owner / manager / Rapid Rise on
-- THIS farm, farm access, and a reading that belongs to the named farm and machine. The
-- search_path is pinned, the function is revoked from anon, and the audit trigger records
-- the void like any other change.
create or replace function public.correct_meter_reading(
  p_farm uuid,
  p_machine uuid,
  p_reading uuid,
  p_reason text default null
) returns numeric
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_role user_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_reading numeric;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null or v_role not in ('rr_admin','owner','manager') then
    raise exception 'Only this farm''s owner or manager may correct a meter reading.'
      using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'That reason is too long.' using errcode = '22023';
  end if;

  -- The UPDATE is RLS-checked in its own right; this is here so a wrong id is a sentence
  -- rather than a silent no-op.
  perform 1
     from public.meter_readings mr
    where mr.id = p_reading
      and mr.machine_id = p_machine
      and mr.farm_id = p_farm
      and mr.deleted_at is null
    for update;
  if not found then
    raise exception 'That meter reading was not found.' using errcode = '42501';
  end if;

  -- The only write. `app_meter_reading_voided` (above) rolls the machine back and
  -- recalculates, so a void performed any other way behaves identically.
  update public.meter_readings
     set deleted_at = now(),
         deleted_by = auth.uid(),
         voided_reason = v_reason
   where id = p_reading
     and farm_id = p_farm;

  select er.reading into v_reading from app.machine_effective_reading(p_machine) er;
  return v_reading;
end $$;

revoke execute on function public.correct_meter_reading(uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.correct_meter_reading(uuid, uuid, uuid, text)
  to authenticated, service_role;

comment on function public.correct_meter_reading(uuid, uuid, uuid, text) is
  'Voids one mistyped meter reading, rolls the machine back to what the surviving history '
  'says, and recalculates its service plan. The audit trigger keeps the original row.';

-- ── Recording a replaced meter ──────────────────────────────────────────────
create or replace function public.record_meter_replacement(
  p_farm uuid,
  p_machine uuid,
  p_new_reading numeric,
  p_replaced_on date default current_date,
  p_note text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_role user_role;
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_meter_type meter_type;
  v_previous numeric;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null or v_role not in ('rr_admin','owner','manager') then
    raise exception 'Only this farm''s owner or manager may record a meter replacement.'
      using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if p_new_reading is null or p_new_reading < 0 or p_new_reading > 99999999999.9 then
    raise exception 'A valid non-negative starting reading is required.' using errcode = '22023';
  end if;
  if p_replaced_on is null or p_replaced_on > current_date then
    raise exception 'A meter replacement cannot be dated in the future.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'That note is too long.' using errcode = '22023';
  end if;

  select m.meter_type, m.current_reading
    into v_meter_type, v_previous
    from public.machines m
   where m.id = p_machine
     and m.farm_id = p_farm
     and m.deleted_at is null
   for update;
  if not found then
    raise exception 'Machine not found.' using errcode = '42501';
  end if;
  if v_meter_type = 'none' then
    raise exception 'That machine does not keep a meter reading.' using errcode = '22023';
  end if;

  -- The only write. `meter_replacements_ins` decides whether this person may make it, and
  -- `app_meter_replacement_after` (below) sets the new baseline, rebases the plan and
  -- recalculates the due dates.
  insert into public.meter_replacements(
    farm_id, machine_id, replaced_on, previous_reading, new_reading, note, created_by
  ) values (
    p_farm, p_machine, p_replaced_on, v_previous, p_new_reading, v_note, auth.uid()
  ) returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.record_meter_replacement(uuid, uuid, numeric, date, text)
  from public, anon;
grant execute on function public.record_meter_replacement(uuid, uuid, numeric, date, text)
  to authenticated, service_role;

comment on function public.record_meter_replacement(uuid, uuid, numeric, date, text) is
  'Records that a machine''s hour meter or odometer was replaced, sets the new baseline and '
  'rebases the service plan by the difference, so a meter starting again at zero does not '
  'leave every service unreachable.';
