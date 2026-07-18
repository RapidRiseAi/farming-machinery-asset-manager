-- 0008_audit_and_triggers.sql
-- Append-only audit log + generic audit trigger; job-card cost computation;
-- job-card lock enforcement (cards lock after approval, edits blocked thereafter).
--
-- NOTE: the trigger functions are SECURITY DEFINER. On Supabase they are owned by
-- `postgres` (which has BYPASSRLS); locally they are owned by the superuser running
-- the migration. Either way they can write audit_log / recompute totals regardless
-- of the caller's RLS.

-- ── Append-only audit log ─────────────────────────────────────────
create table audit_log (
  id        bigint generated always as identity primary key,
  farm_id   uuid,
  user_id   uuid,
  entity    text not null,     -- table name
  entity_id uuid,
  action    text not null,     -- insert | update | delete
  diff      jsonb,
  at        timestamptz not null default now()
);
create index audit_log_farm_idx   on audit_log(farm_id);
create index audit_log_entity_idx on audit_log(entity, entity_id);

-- ── Generic audit trigger ─────────────────────────────────────────
create or replace function app_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_farm uuid;
  v_eid  uuid;
  v_diff jsonb;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  if tg_op = 'DELETE' then
    v_farm := (to_jsonb(old) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(old) ->> 'id')::uuid;
    v_diff := jsonb_build_object('old', to_jsonb(old));
  elsif tg_op = 'UPDATE' then
    v_farm := (to_jsonb(new) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(new) ->> 'id')::uuid;
    v_diff := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  else
    v_farm := (to_jsonb(new) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(new) ->> 'id')::uuid;
    v_diff := jsonb_build_object('new', to_jsonb(new));
  end if;

  insert into audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (v_farm, v_user, tg_table_name, v_eid, lower(tg_op), v_diff);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- Attach the audit trigger to every business table.
do $do$
declare t text;
begin
  foreach t in array array[
    'farms','workshops','users','workshop_links','machines','meter_readings',
    'service_templates','service_plan_lines','faults','job_cards','job_card_lines',
    'watch_items','attachments','notifications','fuel_tanks','fuel_deliveries','fuel_issues'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I '
      'for each row execute function app_audit()', t || '_audit', t);
  end loop;
end $do$;

-- ── Job-card line total computation (money in integer cents) ──────
create or replace function app_compute_line_total() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.kind = 'part' then
    new.total_cents := (round(coalesce(new.qty, 0) * coalesce(new.unit_cost_cents, 0)))::bigint;
  elsif new.kind = 'labour' then
    new.total_cents := (round(coalesce(new.hours, 0) * coalesce(new.rate_cents, 0)))::bigint;
  else -- 'other': a flat amount stored in unit_cost_cents
    new.total_cents := coalesce(new.unit_cost_cents, new.total_cents, 0);
  end if;
  return new;
end $$;

create trigger job_card_lines_compute
  before insert or update on job_card_lines
  for each row execute function app_compute_line_total();

-- ── Recompute job-card totals from its lines ─────────────────────
create or replace function app_recompute_jobcard_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_jc uuid;
begin
  v_jc := coalesce(new.job_card_id, old.job_card_id);
  update job_cards jc set
    parts_total_cents  = t.p,
    labour_total_cents = t.l,
    other_total_cents  = t.o,
    total_cents        = t.p + t.l + t.o
  from (
    select
      coalesce(sum(total_cents) filter (where kind = 'part'),   0) as p,
      coalesce(sum(total_cents) filter (where kind = 'labour'), 0) as l,
      coalesce(sum(total_cents) filter (where kind = 'other'),  0) as o
    from job_card_lines
    where job_card_id = v_jc and deleted_at is null
  ) t
  where jc.id = v_jc;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger job_card_lines_totals
  after insert or update or delete on job_card_lines
  for each row execute function app_recompute_jobcard_totals();

-- ── Job-card lock enforcement ────────────────────────────────────
-- Once a card is locked (approved), it and its lines may not be modified.
-- The approving UPDATE itself is allowed because OLD.locked is still false.
create or replace function app_enforce_jobcard_lock() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(old.locked, false) then
    raise exception 'job card % is locked (approved) and cannot be modified', old.id
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger job_cards_lock
  before update or delete on job_cards
  for each row execute function app_enforce_jobcard_lock();

create or replace function app_enforce_jobcard_line_lock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_locked boolean; v_jc uuid;
begin
  v_jc := coalesce(new.job_card_id, old.job_card_id);
  select locked into v_locked from job_cards where id = v_jc;
  if coalesce(v_locked, false) then
    raise exception 'job card % is locked; its lines cannot be modified', v_jc
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger job_card_lines_lock
  before insert or update or delete on job_card_lines
  for each row execute function app_enforce_jobcard_line_lock();

-- These are trigger-only functions living in the API-exposed `public` schema.
-- Revoke EXECUTE so they can never be called via PostgREST RPC (they still fire as
-- triggers regardless of these grants).
revoke execute on function
  app_audit(),
  app_compute_line_total(),
  app_recompute_jobcard_totals(),
  app_enforce_jobcard_lock(),
  app_enforce_jobcard_line_lock()
from anon, authenticated, public;
