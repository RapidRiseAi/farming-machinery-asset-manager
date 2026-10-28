-- 20261028100400_support_due_at.sql
-- When an answer is due, from the support calendar (20261028100200 hours, 20261028100300
-- holidays). Mirrored for labels and tests by src/lib/support/sla.ts; keep them together.
--
-- The rule (founder default, 2026-10-28), in the support desk's own time zone:
--   * received on a working day between opening and the same-day cutoff (09:00 to 16:00):
--     due at closing (17:00) that day;
--   * received on a working day before opening: due at 12:00 THAT day, the next working day
--     to begin;
--   * anything else (after 16:00, a weekend, a public holiday): 12:00 on the next working day.
--
-- Worked in the desk's zone on purpose: Supabase runs UTC, and between 00:00 and 02:00 SAST
-- the server's date is yesterday (CLAUDE.md, "A date decided in SAST cannot be bounded by
-- current_date").

create or replace function app.support_working_day(p_day date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select extract(isodow from p_day)::smallint = any (
           coalesce((select s.working_days from public.support_settings s where s.singleton),
                    '{1,2,3,4,5}'::smallint[]))
     and not exists (select 1 from public.support_holidays h where h.day = p_day);
$$;

create or replace function app.support_due_at(p_from timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz      text := 'Africa/Johannesburg';
  v_open    time := '09:00';
  v_close   time := '17:00';
  v_cutoff  time := '16:00';
  v_next    time := '12:00';
  v_local   timestamp;
  v_day     date;
  v_time    time;
  v_steps   integer := 0;
begin
  select s.timezone, s.opens_at, s.closes_at, s.same_day_cutoff, s.next_day_due
    into v_tz, v_open, v_close, v_cutoff, v_next
    from public.support_settings s where s.singleton;
  if not found then
    v_tz := 'Africa/Johannesburg'; v_open := '09:00'; v_close := '17:00';
    v_cutoff := '16:00'; v_next := '12:00';
  end if;

  v_local := coalesce(p_from, now()) at time zone v_tz;
  v_day := v_local::date;
  v_time := v_local::time;

  if app.support_working_day(v_day) then
    if v_time < v_open then
      return (v_day + v_next) at time zone v_tz;
    end if;
    if v_time < v_cutoff then
      return (v_day + v_close) at time zone v_tz;
    end if;
  end if;

  -- The next working day. Bounded, so a calendar with every day marked closed cannot loop.
  loop
    v_day := v_day + 1;
    v_steps := v_steps + 1;
    exit when app.support_working_day(v_day) or v_steps >= 60;
  end loop;
  return (v_day + v_next) at time zone v_tz;
end $$;

comment on function app.support_due_at(timestamptz) is
  'When a support answer is due for a request received at p_from: 09:00 to 16:00 on a working '
  'day is due 17:00 that day, before 09:00 is due 12:00 that day, anything else 12:00 the next '
  'working day (hours and holidays from support_settings and support_holidays).';

revoke execute on function app.support_working_day(date) from public, anon, authenticated;
revoke execute on function app.support_due_at(timestamptz) from public, anon, authenticated;
