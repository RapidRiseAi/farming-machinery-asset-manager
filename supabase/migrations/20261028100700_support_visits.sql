-- 20261028100700_support_visits.sql
-- Rapid Rise looking inside a customer's farm: why, for how long, and shown to the owner.
--
-- Support mode (S10, lib/auth.ts) used to record "impersonate" and "exit" in the activity
-- log and nothing else: no reason, no case, and the customer never saw it. Founder defaults
-- (2026-10-28):
--   * a reason (a support case, or a sentence) is required to go in;
--   * staff may change things while inside (onboarding needs it), and every change is
--     attributed to the named admin by the audit trigger, as before;
--   * owners see a "Rapid Rise support visits" list in Settings. No per-visit consent
--     prompt: the service agreement and terms cover support access.
--
-- A table of its own rather than more rows in audit_log: the activity log is being reworked
-- by another change, and the owner's list must not depend on how that log is filed. The
-- existing log_admin_farm_access rows (with place and device) are still written as well.

create table if not exists public.support_visits (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.farms(id),
  admin_id    uuid not null references public.users(id),
  ticket_id   uuid references public.support_tickets(id),
  reason      text not null check (btrim(reason) <> '' and char_length(reason) <= 300),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

comment on table public.support_visits is
  'Each time Rapid Rise entered a farm in support mode: who, why (reason, optional case), when '
  'and until when. Owners read their farm''s through my_farm_support_visits().';

create index if not exists support_visits_farm_idx on public.support_visits (farm_id, started_at desc);
create index if not exists support_visits_open_idx on public.support_visits (admin_id) where ended_at is null;

alter table public.support_visits enable row level security;
alter table public.support_visits force row level security;
drop policy if exists support_visits_sel on public.support_visits;
create policy support_visits_sel on public.support_visits
  for select to authenticated using (app.is_rr_support());
revoke all on public.support_visits from anon, authenticated;
grant select on public.support_visits to authenticated;
grant select on public.support_visits to service_role;

-- == Going in ==================================================================
create or replace function public.support_visit_start(
  p_farm uuid, p_reason text, p_ticket uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id uuid;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if p_farm is null or not exists (select 1 from public.farms f where f.id = p_farm and f.deleted_at is null) then
    raise exception 'support-visit-farm' using errcode = '22023';
  end if;
  if p_ticket is not null
     and not exists (select 1 from public.support_tickets t where t.id = p_ticket and t.farm_id = p_farm) then
    raise exception 'support-visit-ticket' using errcode = '22023';
  end if;
  -- A reason, or a case to stand for one. The case's subject is not copied: the owner reads
  -- this list, and a case may have been asked by someone else.
  if v_reason is null and p_ticket is null then
    raise exception 'support-visit-reason' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 300 then
    raise exception 'support-visit-reason' using errcode = '22023';
  end if;

  -- One visit at a time: entering a farm ends any visit this admin left open.
  update public.support_visits set ended_at = now()
   where admin_id = auth.uid() and ended_at is null;

  insert into public.support_visits (farm_id, admin_id, ticket_id, reason)
  values (p_farm, auth.uid(), p_ticket, coalesce(v_reason, 'Support request'))
  returning id into v_id;

  -- The existing access record, with place and device (0510).
  perform public.log_admin_farm_access(p_farm, 'impersonate');
  return v_id;
end $$;

-- == Coming out ================================================================
create or replace function public.support_visit_end(p_farm uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  update public.support_visits set ended_at = now()
   where admin_id = auth.uid() and ended_at is null and farm_id = p_farm;
  perform public.log_admin_farm_access(p_farm, 'exit');
end $$;

revoke execute on function public.support_visit_start(uuid, text, uuid) from public, anon;
revoke execute on function public.support_visit_end(uuid) from public, anon;
grant execute on function public.support_visit_start(uuid, text, uuid) to authenticated;
grant execute on function public.support_visit_end(uuid) to authenticated;

-- == The owner's list ==========================================================
-- The farm's own owner (in this farm, membership first) or Rapid Rise. Nobody else: a
-- manager, mechanic, driver or contractor gets nothing.
create or replace function public.my_farm_support_visits(p_farm uuid)
returns table (
  id          uuid,
  started_at  timestamptz,
  ended_at    timestamptz,
  reason      text,
  admin_name  text,
  about_case  boolean
)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id, v.started_at, v.ended_at, v.reason, u.name, v.ticket_id is not null
    from public.support_visits v
    left join public.users u on u.id = v.admin_id
   where v.farm_id = p_farm
     and (app.effective_farm_role(auth.uid(), p_farm) = 'owner' or app.is_rr_support())
   order by v.started_at desc
   limit 50;
$$;

comment on function public.my_farm_support_visits(uuid) is
  'Rapid Rise support visits to one farm, for that farm''s owner (or Rapid Rise): when, how '
  'long, why and who.';

revoke execute on function public.my_farm_support_visits(uuid) from public, anon;
grant execute on function public.my_farm_support_visits(uuid) to authenticated;
