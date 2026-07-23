-- 0261_notification_prefs.sql
-- Per-user notification preferences (FR-14.3) + Web-Push delivery bookkeeping (FR-14.1).
--
-- Every recipient gets channel toggles (in-app / push) and optional per-user quiet hours
-- that override the farm-wide window. The enqueue path (app.notify_farm) honours the
-- in-app toggle and per-user quiet hours; the push delivery path (app-layer, 0262/route)
-- honours the push toggle. Preferences default to "on" so existing behaviour is unchanged.

-- ── Per-user preference columns ───────────────────────────────────
alter table users
  add column if not exists notify_inapp      boolean not null default true,
  add column if not exists notify_push       boolean not null default true,
  add column if not exists quiet_hours_start int,   -- null → inherit the farm's window
  add column if not exists quiet_hours_end   int;

-- ── Push delivery marker on notifications ─────────────────────────
-- The push worker sets this when a queued row has been pushed to the user's devices, so a
-- row is pushed at most once (dedupe), independent of the in-app read state.
alter table notifications
  add column if not exists push_sent_at timestamptz;

-- Helps the push worker find deliverable, not-yet-pushed rows cheaply.
create index if not exists notifications_push_pending_idx
  on notifications(user_id)
  where push_sent_at is null and deleted_at is null;

-- ── Per-user quiet-hours resolver ─────────────────────────────────
-- If the user set their own window, compute the hold-until against it; otherwise fall back
-- to the farm-level gate already computed by the caller (p_farm_deliver_after).
create or replace function app.user_deliver_after(
  p_user_start int, p_user_end int, p_farm_deliver_after timestamptz
) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_user_start is not null and p_user_end is not null then
      app.quiet_deliver_after(jsonb_build_object(
        'quiet_hours_start', p_user_start, 'quiet_hours_end', p_user_end))
    else p_farm_deliver_after
  end;
$$;

-- ── Prefs-aware notify_farm (both overloads) ──────────────────────
-- 3-arg (0203; fault/job triggers): now skips users who turned off in-app.
create or replace function app.notify_farm(p_farm uuid, p_template text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (farm_id, user_id, channel, template, payload, status)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued'
  from users u
  where u.farm_id = p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null
    and coalesce(u.notify_inapp, true);
end $$;

-- 4-arg (0205; enqueue engine): skips in-app opt-outs and applies per-user quiet hours,
-- falling back to the farm-level gate the caller passed in.
create or replace function app.notify_farm(
  p_farm uuid, p_template text, p_payload jsonb, p_deliver_after timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (farm_id, user_id, channel, template, payload, status, deliver_after)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued',
         app.user_deliver_after(u.quiet_hours_start, u.quiet_hours_end, p_deliver_after)
  from users u
  where u.farm_id = p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null
    and coalesce(u.notify_inapp, true);
end $$;

-- ── Self-service preference RPC ───────────────────────────────────
-- Any signed-in user updates ONLY their own preference columns (never role/farm). Nulls
-- for the quiet-hour fields clear a custom window (inherit the farm's).
create or replace function public.set_notification_prefs(
  p_inapp boolean, p_push boolean, p_quiet_start int, p_quiet_end int
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update users set
    notify_inapp      = coalesce(p_inapp, notify_inapp),
    notify_push       = coalesce(p_push,  notify_push),
    quiet_hours_start = p_quiet_start,
    quiet_hours_end   = p_quiet_end
  where id = auth.uid();
end $$;

-- ── Lock down (0205 pattern) ──────────────────────────────────────
revoke execute on function app.notify_farm(uuid, text, jsonb)                 from public, anon, authenticated;
revoke execute on function app.notify_farm(uuid, text, jsonb, timestamptz)    from public, anon, authenticated;
revoke execute on function app.user_deliver_after(int, int, timestamptz)      from public, anon, authenticated;
grant  execute on function app.notify_farm(uuid, text, jsonb)                 to service_role;
grant  execute on function app.notify_farm(uuid, text, jsonb, timestamptz)    to service_role;
grant  execute on function app.user_deliver_after(int, int, timestamptz)      to service_role;

revoke execute on function public.set_notification_prefs(boolean, boolean, int, int) from public, anon;
grant  execute on function public.set_notification_prefs(boolean, boolean, int, int) to authenticated;
