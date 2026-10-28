-- 20261028100300_support_holidays.sql
-- Days nobody is on the support desk.
--
-- Founder default (2026-10-28): South African public holidays are non-support days. They
-- are rows, not code, so a newly declared day (an election day, a special holiday) is one
-- entry on /admin/support/settings rather than a deploy.
--
-- Seeded for 2026 and 2027 from the Public Holidays Act: the twelve fixed and Easter days,
-- plus the Monday after any that falls on a Sunday. Not seeded: days declared later (the
-- 2026/27 local government election day was not proclaimed when this was written).

create table if not exists public.support_holidays (
  day         date primary key,
  name        text not null check (btrim(name) <> '' and char_length(name) <= 80),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id)
);

comment on table public.support_holidays is
  'Days the support desk is closed (SA public holidays by default). Read by app.support_due_at; '
  'kept by Rapid Rise on /admin/support/settings.';

insert into public.support_holidays (day, name) values
  ('2026-01-01', 'New Year''s Day'),
  ('2026-03-21', 'Human Rights Day'),
  ('2026-04-03', 'Good Friday'),
  ('2026-04-06', 'Family Day'),
  ('2026-04-27', 'Freedom Day'),
  ('2026-05-01', 'Workers'' Day'),
  ('2026-06-16', 'Youth Day'),
  ('2026-08-09', 'National Women''s Day'),
  ('2026-08-10', 'National Women''s Day (observed)'),
  ('2026-09-24', 'Heritage Day'),
  ('2026-12-16', 'Day of Reconciliation'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-26', 'Day of Goodwill'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-03-21', 'Human Rights Day'),
  ('2027-03-22', 'Human Rights Day (observed)'),
  ('2027-03-26', 'Good Friday'),
  ('2027-03-29', 'Family Day'),
  ('2027-04-27', 'Freedom Day'),
  ('2027-05-01', 'Workers'' Day'),
  ('2027-06-16', 'Youth Day'),
  ('2027-08-09', 'National Women''s Day'),
  ('2027-09-24', 'Heritage Day'),
  ('2027-12-16', 'Day of Reconciliation'),
  ('2027-12-25', 'Christmas Day'),
  ('2027-12-26', 'Day of Goodwill'),
  ('2027-12-27', 'Day of Goodwill (observed)')
on conflict (day) do nothing;

alter table public.support_holidays enable row level security;
alter table public.support_holidays force row level security;
drop policy if exists support_holidays_sel on public.support_holidays;
create policy support_holidays_sel on public.support_holidays
  for select to authenticated using (app.is_rr_support());
revoke all on public.support_holidays from anon, authenticated;
grant select on public.support_holidays to authenticated;
grant select, insert, update, delete on public.support_holidays to service_role;

-- == Rapid Rise keeps the list ==================================================
create or replace function public.support_holiday_set(p_day date, p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin() then
    raise exception 'Rapid Rise only.' using errcode = '42501';
  end if;
  if p_day is null or nullif(btrim(coalesce(p_name, '')), '') is null or char_length(btrim(p_name)) > 80 then
    raise exception 'support-holiday-invalid' using errcode = '22023';
  end if;
  insert into public.support_holidays (day, name, created_by)
  values (p_day, btrim(p_name), auth.uid())
  on conflict (day) do update set name = excluded.name, created_by = excluded.created_by;
end $$;

create or replace function public.support_holiday_remove(p_day date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin() then
    raise exception 'Rapid Rise only.' using errcode = '42501';
  end if;
  delete from public.support_holidays where day = p_day;
end $$;

revoke execute on function public.support_holiday_set(date, text) from public, anon;
revoke execute on function public.support_holiday_remove(date) from public, anon;
grant execute on function public.support_holiday_set(date, text) to authenticated;
grant execute on function public.support_holiday_remove(date) to authenticated;
