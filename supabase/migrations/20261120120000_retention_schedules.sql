-- 20261120120000_retention_schedules.sql
-- Scheduled deletion after the owner's 90 days (BRIEF section 16; decisions 38 and 40; scenarios
-- 11 and 29). A future policy, shipped SWITCHED OFF: until the founder turns it on, the nightly
-- pass only works out who would be deleted and when, and records a dry-run preview. Nothing is
-- deleted and no customer is told anything is scheduled.
--
-- == One deletion path ==========================================================================
-- Deleting reuses public.close_farm_permanently (20261107100000, 20261110090000), the owner's
-- permanent closure: everything with a farm_id goes unless it is billing evidence, which
-- farm_closures keeps for five years and public.purge_expired_closures removes after that. A
-- retention deletion is a closure with reason 'retention' and the basis it was decided on. There
-- is no second deleting engine to drift from the first.
--
-- == The schedule ===============================================================================
-- public.retention_schedule_run (nightly) keeps one row per business whose subscription ended
-- unpaid or cancelled: the last reading day (A2's retrieval_ends_on, public.farm_lifecycle) and
-- the day deletion may happen, retention_settings.delay_days later (30 by default, a product
-- choice to confirm). A business that pays or reopens has its schedule cancelled. While the
-- setting is on, owners are warned (30, 7 and 1 days before), and deletion is never sooner than
-- 30 days after the first warning, whenever that went out.
--
-- == Before anything is deleted (public.retention_delete) =========================================
-- The setting is on; the schedule is due; the first warning went out at least 30 days ago; the
-- business is still closed for non-payment or cancellation and past its reading window; it is not
-- exempt from billing; no payment is in flight; no hold (legal, dispute, support) is active. Every
-- check is made again inside the transaction that deletes, which either completes or changes
-- nothing. Files and logins are removed afterwards by the server and finished nightly
-- (farm_closures.pending_files, pending_logins). A login that belongs to another business is never
-- removed: close_farm_permanently moves such a person to their other business, and only someone
-- who belongs nowhere else is removed.
--
-- == Safe on live data ==========================================================================
-- New tables and functions; two new nullable columns on farm_closures; the setting starts off.
set lock_timeout = '3s';

-- The deletion ledger: every closure by ids and dates, in Storage, which a database restore does not
-- roll back (docs/BACKUP.md). Private, service role only, outside every business's folder.
do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('deletion-ledger', 'deletion-ledger', false)
    on conflict (id) do update set public = false;
  end if;
end
$storage$;

create table if not exists public.retention_settings (
  singleton         boolean primary key default true check (singleton),
  deletion_enabled  boolean not null default false,
  delay_days        integer not null default 30 check (delay_days between 0 and 3650),
  enabled_by        uuid references public.users(id) on delete set null,
  enabled_at        timestamptz,
  updated_at        timestamptz not null default now()
);
insert into public.retention_settings (singleton) values (true) on conflict do nothing;
alter table public.retention_settings enable row level security;
alter table public.retention_settings force row level security;
revoke all on public.retention_settings from public, anon, authenticated;
grant select on public.retention_settings to authenticated;
grant all on public.retention_settings to service_role;
drop policy if exists retention_settings_sel on public.retention_settings;
create policy retention_settings_sel on public.retention_settings for select to authenticated using ((select app.is_rr_admin()));
drop trigger if exists retention_settings_audit on public.retention_settings;
create trigger retention_settings_audit after insert or update or delete on public.retention_settings
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('retention_settings', 'rapid_rise', 'whether scheduled deletion runs, and who turned it on')
on conflict (table_name) do nothing;

create table if not exists public.farm_retention_schedules (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null unique references public.farms(id) on delete cascade,
  reason            text not null check (reason in ('unpaid', 'cancelled')),
  retrieval_ends_on date not null,
  delete_after      date not null,
  status            text not null default 'scheduled' check (status in ('scheduled', 'held', 'cancelled', 'failed')),
  first_warned_at   timestamptz,
  warnings_sent     integer[] not null default '{}',
  preview           jsonb,
  previewed_at      timestamptz,
  attempts          integer not null default 0 check (attempts between 0 and 1000),
  last_error        text check (last_error is null or length(last_error) <= 300),
  cancelled_reason  text check (cancelled_reason is null or length(cancelled_reason) <= 200),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint farm_retention_schedules_dates_ck check (delete_after > retrieval_ends_on)
);
comment on table public.farm_retention_schedules is
  'When a business that ended unpaid or cancelled may be deleted, the warnings sent and the last '
  'dry-run preview (20261120120000). Removed with the business by the closure that deletes it; '
  'farm_closures (reason retention) is the lasting record.';

create table if not exists public.farm_retention_holds (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null references public.farms(id) on delete cascade,
  kind         text not null check (kind in ('legal', 'dispute', 'support', 'other')),
  reason       text not null check (length(btrim(reason)) between 1 and 500),
  placed_by    uuid references public.users(id) on delete set null,
  placed_at    timestamptz not null default now(),
  released_by  uuid references public.users(id) on delete set null,
  released_at  timestamptz
);
create index if not exists farm_retention_holds_active_idx on public.farm_retention_holds (farm_id) where released_at is null;
comment on table public.farm_retention_holds is
  'A reason not to delete a business yet (a legal hold, a dispute, a support case), placed and '
  'released by Rapid Rise (20261120120000).';

do $$
declare t text;
begin
  foreach t in array array['farm_retention_schedules', 'farm_retention_holds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select app.is_rr_admin()))', t || '_sel', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.app_audit()', t || '_audit', t);
    execute format('insert into app.audit_table_rules (table_name, scope, reason) values (%L, %L, %L) on conflict (table_name) do nothing',
                   t, 'rapid_rise', 'deletion after the reading window: Rapid Rise only');
    execute format('insert into app.pay_gate_rules (table_name, rule, reason) values (%L, %L, %L) on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason',
                   t, 'open', 'Rapid Rise''s deletion schedule for a stopped business');
    perform app.pay_gate_apply(t);
  end loop;
end $$;

alter table public.farm_closures add column if not exists reason text not null default 'owner';
alter table public.farm_closures add column if not exists basis jsonb;
alter table public.farm_closures add column if not exists pending_logins uuid[] not null default '{}';
alter table public.farm_closures drop constraint if exists farm_closures_reason_ck;
alter table public.farm_closures add constraint farm_closures_reason_ck check (reason in ('owner', 'retention'));
comment on column public.farm_closures.reason is
  'owner: the owner closed the account (20261107100000); retention: deleted after the reading window '
  'by public.retention_delete (20261120120000), with the basis it was decided on.';

-- == What a deletion would do, without doing it =================================================
-- Counts per table of what goes and what stays, the files, who would be removed and who moved,
-- and every check the deleting function makes. Rapid Rise reads it before switching deletion on;
-- the nightly pass stores the latest one on the schedule.
create or replace function app.retention_checks(p_farm uuid, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.farms%rowtype;
  v_life jsonb := app.farm_lifecycle(p_farm, p_today);
  v_sched public.farm_retention_schedules%rowtype;
  v_set public.retention_settings%rowtype;
  v_end date;
  v_blocks text[] := '{}';
begin
  select * into f from public.farms where id = p_farm;
  select * into v_sched from public.farm_retention_schedules where farm_id = p_farm;
  select * into v_set from public.retention_settings where singleton;
  v_end := nullif(v_life ->> 'retrieval_ends_on', '')::date;
  if not found or f.deleted_at is not null then v_blocks := array_append(v_blocks, 'already-closed'::text); end if;
  if not coalesce(v_set.deletion_enabled, false) then v_blocks := array_append(v_blocks, 'deletion-off'::text); end if;
  if v_life ->> 'state' is distinct from 'closed' or v_life ->> 'reason' not in ('unpaid', 'cancelled') then
    v_blocks := array_append(v_blocks, 'not-closed-for-payment'::text);
  end if;
  if v_end is null or v_end >= p_today then v_blocks := array_append(v_blocks, 'reading-window-open'::text); end if;
  if coalesce(f.billing_exempt, false) then v_blocks := array_append(v_blocks, 'billing-exempt'::text); end if;
  if exists (select 1 from public.farm_retention_holds h where h.farm_id in (p_farm, app.billing_root(p_farm)) and h.released_at is null) then
    v_blocks := array_append(v_blocks, 'hold'::text);
  end if;
  if exists (select 1 from public.billing_payment_attempts a
              where a.farm_id = app.billing_root(p_farm) and a.status = 'pending' and a.requested_at > now() - interval '2 days') then
    v_blocks := array_append(v_blocks, 'payment-in-flight'::text);
  end if;
  if v_sched.id is null then v_blocks := array_append(v_blocks, 'not-scheduled'::text);
  else
    if v_sched.status <> 'scheduled' then v_blocks := array_append(v_blocks, ('schedule-' || v_sched.status)::text); end if;
    if v_sched.delete_after > p_today then v_blocks := array_append(v_blocks, 'not-due'::text); end if;
    if v_sched.first_warned_at is null or v_sched.first_warned_at > now() - interval '30 days' then
      v_blocks := array_append(v_blocks, 'warning-too-recent'::text);
    end if;
  end if;
  return jsonb_build_object(
    'state', v_life ->> 'state', 'reason', v_life ->> 'reason', 'retrieval_ends_on', v_end,
    'delete_after', v_sched.delete_after, 'first_warned_at', v_sched.first_warned_at,
    'deletion_enabled', coalesce(v_set.deletion_enabled, false),
    'blocked_by', to_jsonb(v_blocks), 'may_delete', cardinality(v_blocks) = 0);
end $$;
revoke all on function app.retention_checks(uuid, date) from public, anon, authenticated, service_role;

create or replace function public.retention_preview(p_farm uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_keep text[] := array['billing_invoices', 'billing_invoice_lines', 'billing_payments',
                         'billing_payment_attempts', 'billing_subscriptions', 'farm_closures'];
  t record;
  v_n bigint;
  v_goes jsonb := '{}'::jsonb;
  v_kept jsonb := '{}'::jsonb;
  v_rows bigint := 0;
  v_files bigint := 0;
  v_bytes bigint := 0;
begin
  for t in
    select c.table_schema s, c.table_name n
      from information_schema.columns c
      join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
     where c.column_name = 'farm_id' and b.table_type = 'BASE TABLE' and c.table_schema in ('public', 'app')
     order by c.table_name
  loop
    execute format('select count(*) from %I.%I where farm_id = $1', t.s, t.n) using p_farm into v_n;
    continue when v_n = 0;
    if t.n = any (v_keep) then
      v_kept := v_kept || jsonb_build_object(t.n, v_n);
    else
      v_goes := v_goes || jsonb_build_object(t.n, v_n);
      v_rows := v_rows + v_n;
    end if;
  end loop;
  select count(*), coalesce(sum(size), 0) into v_files, v_bytes from public.farm_file_objects(p_farm);
  return jsonb_build_object(
    'farm_id', p_farm,
    'checks', app.retention_checks(p_farm, app.billing_today()),
    'rows_removed', v_rows, 'tables_removed', v_goes, 'kept_for_five_years', v_kept,
    'files', v_files, 'file_bytes', v_bytes,
    'logins_removed', (select count(*) from public.users u where u.farm_id = p_farm
                         and not exists (select 1 from public.user_farm_memberships m
                                          where m.user_id = u.id and m.farm_id <> p_farm and m.active and m.deleted_at is null)),
    'logins_moved', (select count(*) from public.users u where u.farm_id = p_farm
                       and exists (select 1 from public.user_farm_memberships m
                                    where m.user_id = u.id and m.farm_id <> p_farm and m.active and m.deleted_at is null)),
    'previewed_at', now());
end $$;

-- == The nightly schedule (dry run while deletion is off) ========================================
create or replace function public.retention_schedule_run() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_today date := app.billing_today();
  v_set public.retention_settings%rowtype;
  v_life jsonb;
  v_end date;
  v_after date;
  s public.farm_retention_schedules%rowtype;
  v_stage integer;
  v_scheduled integer := 0;
  v_cancelled integer := 0;
  v_warned integer := 0;
  v_previewed integer := 0;
begin
  select * into v_set from public.retention_settings where singleton;

  -- Businesses that came back: their schedule ends.
  for s in select * from public.farm_retention_schedules where status in ('scheduled', 'held', 'failed') for update skip locked loop
    v_life := app.farm_lifecycle(s.farm_id, v_today);
    if v_life ->> 'state' not in ('retrieval', 'closed') or v_life ->> 'reason' not in ('unpaid', 'cancelled')
       or exists (select 1 from public.farms f where f.id = s.farm_id and (f.deleted_at is not null or f.billing_exempt)) then
      update public.farm_retention_schedules
         set status = 'cancelled', cancelled_reason = coalesce(v_life ->> 'state', 'reactivated'), updated_at = now()
       where id = s.id;
      v_cancelled := v_cancelled + 1;
    end if;
  end loop;

  -- Businesses in or past their reading window after a subscription that ended unpaid or cancelled.
  for r in
    select f.id from public.farms f
     where f.deleted_at is null and not f.billing_exempt
       and app.farm_billing_gate_on(f.id, v_today) in ('suspended', 'closed')
  loop
    v_life := app.farm_lifecycle(r.id, v_today);
    continue when v_life ->> 'state' not in ('retrieval', 'closed') or v_life ->> 'reason' not in ('unpaid', 'cancelled');
    v_end := nullif(v_life ->> 'retrieval_ends_on', '')::date;
    continue when v_end is null;
    v_after := v_end + greatest(coalesce(v_set.delay_days, 30), 1);
    insert into public.farm_retention_schedules (farm_id, reason, retrieval_ends_on, delete_after)
    values (r.id, v_life ->> 'reason', v_end, v_after)
    on conflict (farm_id) do update
      set reason = excluded.reason,
          retrieval_ends_on = excluded.retrieval_ends_on,
          -- Never earlier than 30 days after the first warning.
          delete_after = greatest(excluded.delete_after,
                                  coalesce(app.billing_date_of(farm_retention_schedules.first_warned_at) + 30, excluded.delete_after)),
          status = case when farm_retention_schedules.status = 'cancelled' then 'scheduled' else farm_retention_schedules.status end,
          cancelled_reason = null,
          updated_at = now();
    v_scheduled := v_scheduled + 1;
  end loop;

  -- Holds turn a schedule to held, and releasing them back.
  update public.farm_retention_schedules rs set status = 'held', updated_at = now()
   where rs.status = 'scheduled'
     and exists (select 1 from public.farm_retention_holds h where h.farm_id in (rs.farm_id, app.billing_root(rs.farm_id)) and h.released_at is null);
  update public.farm_retention_schedules rs set status = 'scheduled', updated_at = now()
   where rs.status = 'held'
     and not exists (select 1 from public.farm_retention_holds h where h.farm_id in (rs.farm_id, app.billing_root(rs.farm_id)) and h.released_at is null);

  for s in select * from public.farm_retention_schedules where status in ('scheduled', 'held') for update skip locked loop
    -- The dry run: what would go, stored for Rapid Rise to read.
    update public.farm_retention_schedules set preview = public.retention_preview(s.farm_id), previewed_at = now()
     where id = s.id;
    v_previewed := v_previewed + 1;
    -- Warnings only while deletion is switched on: a customer is never told of a deletion that
    -- is not going to happen. The first warning sets the earliest date 30 days out.
    continue when not coalesce(v_set.deletion_enabled, false) or s.status <> 'scheduled';
    if s.first_warned_at is null then
      update public.farm_retention_schedules
         set first_warned_at = now(), delete_after = greatest(delete_after, v_today + 30),
             warnings_sent = array[30], updated_at = now()
       where id = s.id
       returning * into s;
      perform app.billing_notify_owners(s.farm_id, 'retention_deletion_scheduled',
        jsonb_build_object('delete_after', s.delete_after, 'stage', 30, 'retrieval_ends_on', s.retrieval_ends_on));
      v_warned := v_warned + 1;
      continue;
    end if;
    v_stage := case when s.delete_after - v_today <= 1 then 1 when s.delete_after - v_today <= 7 then 7 else null end;
    if v_stage is not null and not (v_stage = any (s.warnings_sent)) then
      update public.farm_retention_schedules set warnings_sent = warnings_sent || v_stage, updated_at = now() where id = s.id;
      perform app.billing_notify_owners(s.farm_id, 'retention_deletion_scheduled',
        jsonb_build_object('delete_after', s.delete_after, 'stage', v_stage, 'retrieval_ends_on', s.retrieval_ends_on));
      v_warned := v_warned + 1;
    end if;
  end loop;

  return jsonb_build_object('scheduled', v_scheduled, 'cancelled', v_cancelled, 'previewed', v_previewed,
                            'warned', v_warned, 'deletion_enabled', coalesce(v_set.deletion_enabled, false));
end $$;

-- Due schedules, for the nightly deletion step (empty while deletion is off).
create or replace function public.retention_due(p_limit integer) returns table (farm_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.farm_id from public.farm_retention_schedules s
   where (select deletion_enabled from public.retention_settings where singleton)
     and s.status = 'scheduled' and s.delete_after <= app.billing_today()
     and s.attempts < 5
   order by s.delete_after
   limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

-- == The deletion itself =========================================================================
create or replace function public.retention_delete(p_farm uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_checks jsonb;
  v_sched public.farm_retention_schedules%rowtype;
  v_result jsonb;
begin
  perform 1 from public.farms where id = p_farm for update;
  select * into v_sched from public.farm_retention_schedules where farm_id = p_farm for update;
  v_checks := app.retention_checks(p_farm, app.billing_today());
  if not (v_checks ->> 'may_delete')::boolean then
    raise exception 'retention-blocked' using errcode = '22023', detail = (v_checks -> 'blocked_by')::text;
  end if;
  v_result := public.close_farm_permanently(p_farm, null);
  update public.farm_closures
     set reason = 'retention',
         basis = jsonb_build_object('retrieval_ends_on', v_sched.retrieval_ends_on, 'delete_after', v_sched.delete_after,
                                    'first_warned_at', v_sched.first_warned_at, 'warnings_sent', to_jsonb(v_sched.warnings_sent),
                                    'subscription_reason', v_sched.reason, 'checks', v_checks),
         pending_logins = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_result -> 'logins') x), '{}')
   where id = (v_result ->> 'closure')::uuid;
  return v_result;
end $$;

-- A failed attempt, recorded apart from the deletion that rolled back.
create or replace function public.retention_mark_failed(p_farm uuid, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.farm_retention_schedules
     set attempts = attempts + 1, last_error = left(coalesce(p_error, 'failed'), 300),
         status = case when attempts + 1 >= 5 then 'failed' else status end, updated_at = now()
   where farm_id = p_farm;
$$;

-- == Rapid Rise: holds and the switch =============================================================
create or replace function public.retention_place_hold(p_by uuid, p_farm uuid, p_kind text, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.farm_retention_holds (farm_id, kind, reason, placed_by) values (p_farm, p_kind, btrim(p_reason), p_by)
  returning id into v_id;
  update public.farm_retention_schedules set status = 'held', updated_at = now() where farm_id = p_farm and status = 'scheduled';
  return v_id;
end $$;

create or replace function public.retention_release_hold(p_by uuid, p_hold uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.farm_retention_holds set released_at = now(), released_by = p_by where id = p_hold and released_at is null;
  if not found then raise exception 'retention-invalid' using errcode = '22023'; end if;
end $$;

-- Switching deletion on is the founder's decision: it takes the typed phrase, and it is audited.
create or replace function public.retention_set_enabled(p_by uuid, p_enabled boolean, p_phrase text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_enabled and p_phrase is distinct from 'DELETE AFTER THE READING WINDOW' then
    raise exception 'retention-phrase' using errcode = '22023';
  end if;
  update public.retention_settings
     set deletion_enabled = p_enabled, enabled_by = case when p_enabled then p_by end,
         enabled_at = case when p_enabled then now() end, updated_at = now()
   where singleton;
end $$;

do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.retention_preview(uuid)'::regprocedure,
    'public.retention_schedule_run()'::regprocedure,
    'public.retention_due(integer)'::regprocedure,
    'public.retention_delete(uuid)'::regprocedure,
    'public.retention_mark_failed(uuid,text)'::regprocedure,
    'public.retention_place_hold(uuid,uuid,text,text)'::regprocedure,
    'public.retention_release_hold(uuid,uuid)'::regprocedure,
    'public.retention_set_enabled(uuid,boolean,text)'::regprocedure]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
reset lock_timeout;
