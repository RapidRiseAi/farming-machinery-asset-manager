-- 20261028100200_support_settings.sql
-- How customers reach Rapid Rise, and when someone is there: data, not code.
--
-- Founder decisions (2026-10-26, "Team and support"): support by WhatsApp, email, phone and
-- in-app; weekdays 09:00 to 17:00 South African time; a same-day answer during those hours.
-- Founder defaults (2026-10-28, until answered):
--   * a request received 09:00 to 16:00 on a working day is due 17:00 that day; anything
--     later, or outside hours, is due 12:00 the next working day;
--   * the human phone and WhatsApp numbers stay HIDDEN until Rapid Rise types them in here
--     (the number in the decision record was only tentatively accepted and must be confirmed before it is shown);
--   * email (team@rapidriseai.com, the company's own role address), in-app and the hours
--     are shown now.
--
-- One row. Customers read it through public.support_contact(); only Rapid Rise changes it,
-- through public.support_update_settings(), which names who did. It carries no farm, so it
-- is not filed in any farm's activity log.

create table if not exists public.support_settings (
  singleton        boolean primary key default true check (singleton),
  email            text not null default 'team@rapidriseai.com',
  -- Null means "not confirmed yet": the help page does not show the channel at all.
  phone            text,
  whatsapp         text,
  timezone         text not null default 'Africa/Johannesburg',
  opens_at         time not null default '09:00',
  closes_at        time not null default '17:00',
  -- Received before this on a working day: due at closes_at the same day.
  same_day_cutoff  time not null default '16:00',
  -- Otherwise due at this time on the next working day.
  next_day_due     time not null default '12:00',
  -- ISO weekdays, Monday 1 to Sunday 7.
  working_days     smallint[] not null default '{1,2,3,4,5}',
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.users(id),
  constraint support_settings_email_ck check (email ~ '^[^@\s,;<>"()]+@[^@\s,;<>"()]+\.[^@\s,;<>"()]+$'),
  constraint support_settings_phone_ck check (phone is null or phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  constraint support_settings_whatsapp_ck check (whatsapp is null or whatsapp ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  constraint support_settings_hours_ck check (opens_at < same_day_cutoff and same_day_cutoff <= closes_at),
  constraint support_settings_next_day_ck check (next_day_due > opens_at and next_day_due <= closes_at),
  constraint support_settings_days_ck check (
    cardinality(working_days) between 1 and 7 and working_days <@ '{1,2,3,4,5,6,7}'::smallint[])
);

comment on table public.support_settings is
  'How customers reach Rapid Rise and when: contact channels (phone and WhatsApp hidden until '
  'set), support hours and the same-day cutoff. One row; read by support_contact(), changed '
  'by support_update_settings().';

insert into public.support_settings (singleton) values (true) on conflict (singleton) do nothing;

alter table public.support_settings enable row level security;
alter table public.support_settings force row level security;
-- Explicit revoke: 0102 grants future tables to `authenticated` by default (SECURITY.md 2b).
revoke all on public.support_settings from anon, authenticated;
grant select, update on public.support_settings to service_role;

-- == What the help page shows ==================================================
create or replace function public.support_contact()
returns table (
  email           text,
  phone           text,
  whatsapp        text,
  timezone        text,
  opens_at        text,
  closes_at       text,
  same_day_cutoff text,
  next_day_due    text,
  working_days    smallint[],
  updated_at      timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.email, s.phone, s.whatsapp, s.timezone,
         to_char(s.opens_at, 'HH24:MI'), to_char(s.closes_at, 'HH24:MI'),
         to_char(s.same_day_cutoff, 'HH24:MI'), to_char(s.next_day_due, 'HH24:MI'),
         s.working_days, s.updated_at
    from public.support_settings s
   where s.singleton and auth.uid() is not null;
$$;

comment on function public.support_contact() is
  'The support channels and hours for any signed-in person. Phone and WhatsApp are null until '
  'Rapid Rise has confirmed and entered them.';

revoke execute on function public.support_contact() from public, anon;
grant execute on function public.support_contact() to authenticated, service_role;

-- == Rapid Rise changes them ===================================================
-- Admin, not merely support staff: these are what every customer is told.
create or replace function public.support_update_settings(
  p_email           text,
  p_phone           text,
  p_whatsapp        text,
  p_opens_at        time,
  p_closes_at       time,
  p_same_day_cutoff time,
  p_next_day_due    time,
  p_working_days    text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_days smallint[];
begin
  if not app.is_rr_admin() then
    raise exception 'Rapid Rise only.' using errcode = '42501';
  end if;
  begin
    v_days := (select array_agg(distinct d::smallint order by d::smallint)
                 from unnest(string_to_array(regexp_replace(coalesce(p_working_days, ''), '\s', '', 'g'), ',')) d
                where d <> '');
  exception when others then
    raise exception 'support-settings-invalid' using errcode = '22023';
  end;
  begin
    update public.support_settings
       set email = lower(btrim(p_email)),
           phone = nullif(btrim(coalesce(p_phone, '')), ''),
           whatsapp = nullif(btrim(coalesce(p_whatsapp, '')), ''),
           opens_at = p_opens_at,
           closes_at = p_closes_at,
           same_day_cutoff = p_same_day_cutoff,
           next_day_due = p_next_day_due,
           working_days = coalesce(v_days, '{}'::smallint[]),
           updated_at = now(),
           updated_by = auth.uid()
     where singleton;
  exception when check_violation or not_null_violation then
    raise exception 'support-settings-invalid' using errcode = '22023';
  end;
end $$;

comment on function public.support_update_settings(text, text, text, time, time, time, time, text) is
  'Rapid Rise (two-step, real account) sets the support channels and hours. Records who.';

revoke execute on function public.support_update_settings(text, text, text, time, time, time, time, text) from public, anon;
grant execute on function public.support_update_settings(text, text, text, time, time, time, time, text) to authenticated;
