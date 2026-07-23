-- 0263_expiry_notifications.sql
-- Warranty + licence expiry reminders (FR-4.7, FR-13.3) — the 0205 engine, extended.
--
-- Follows the 0205 pattern exactly: an app.* engine that is never PostgREST-reachable,
-- EXECUTE revoked from public/anon/authenticated and granted only to service_role, fronted
-- by a public.cron_* wrapper the nightly route calls. Retired/sold + soft-deleted machines
-- never enqueue (Scope §4.1); quiet hours are honoured via app.quiet_deliver_after; and each
-- reminder dedupes on a stored notified_status, re-firing weekly only while expired.
--
-- Two sources feed one engine:
--   * machines.warranty_expiry_date / warranty_expiry_hours → warranty_expiring/_expired
--   * licences.expiry_date                                  → licence_expiring/_expired
-- Per-farm thresholds (settings): warranty_lead_days (30), warranty_hours_lead (50),
-- licence_lead_days (30, a fallback when a licence has no per-row lead).

-- ── Pure status helpers (no table access; mirrored in src/lib/compliance.ts) ──
create or replace function app.expiry_status_of(p_expiry date, p_lead int) returns expiry_status
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_expiry is null then null
    when p_expiry < current_date then 'expired'::expiry_status
    when p_expiry <= current_date + coalesce(p_lead, 30) then 'expiring'::expiry_status
    else 'ok'::expiry_status
  end;
$$;

-- The more severe of two expiry_status values (null = "no signal from this basis").
create or replace function app.worse_expiry(a expiry_status, b expiry_status) returns expiry_status
language sql immutable set search_path = public, pg_temp as $$
  select case
    when a = 'expired'  or b = 'expired'  then 'expired'::expiry_status
    when a = 'expiring' or b = 'expiring' then 'expiring'::expiry_status
    when a = 'ok'       or b = 'ok'       then 'ok'::expiry_status
    else null::expiry_status
  end;
$$;

grant execute on function app.expiry_status_of(date, int)          to authenticated, service_role;
grant execute on function app.worse_expiry(expiry_status, expiry_status) to authenticated, service_role;

-- ── Enqueue engine ────────────────────────────────────────────────
-- Whether a status warrants a (re)notify: fire on any transition into expiring/expired,
-- and re-fire weekly while still expired.
create or replace function app.enqueue_expiry_notifications() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_status        expiry_status;
  v_template      text;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should        boolean;
begin
  -- ── (A) Warranty (machines) ─────────────────────────────────────
  for r in
    select m.id, m.farm_id, m.name as machine_name, m.meter_type, m.current_reading,
           m.warranty_expiry_date, m.warranty_expiry_hours,
           m.warranty_notified_status as notified_status, m.warranty_notified_at as last_notified_at,
           f.settings
    from machines m
    join farms f on f.id = m.farm_id
    where m.deleted_at is null
      and m.status not in ('retired','sold')
      and f.deleted_at is null and f.status in ('trial','active')
      and (m.warranty_expiry_date is not null or m.warranty_expiry_hours is not null)
  loop
    -- combined status = worst of the date basis and (hours meters only) the hours basis
    v_status := app.worse_expiry(
      app.expiry_status_of(r.warranty_expiry_date, coalesce((r.settings->>'warranty_lead_days')::int, 30)),
      case
        when r.meter_type = 'hours' and r.warranty_expiry_hours is not null and r.current_reading is not null then
          case
            when r.current_reading >= r.warranty_expiry_hours then 'expired'::expiry_status
            when r.current_reading >= r.warranty_expiry_hours - coalesce((r.settings->>'warranty_hours_lead')::numeric, 50)
              then 'expiring'::expiry_status
            else 'ok'::expiry_status
          end
        else null::expiry_status
      end
    );

    if v_status is null or v_status = 'ok' then
      if r.notified_status is distinct from v_status then
        update machines set warranty_notified_status = v_status, warranty_notified_at = null where id = r.id;
      end if;
      continue;
    end if;

    v_should := (v_status is distinct from r.notified_status)
             or (v_status = 'expired' and r.notified_status = 'expired'
                 and r.last_notified_at is not null and r.last_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_template := case when v_status = 'expired' then 'warranty_expired' else 'warranty_expiring' end;
    v_payload  := jsonb_build_object(
      'machine_id',        r.id,
      'machine_name',      r.machine_name,
      'status',            v_status,
      'expiry_date',       r.warranty_expiry_date,
      'expiry_hours',      r.warranty_expiry_hours,
      'current_reading',   r.current_reading,
      'unit',              r.meter_type
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, v_template, v_payload, v_deliver_after);
    update machines set warranty_notified_status = v_status, warranty_notified_at = now() where id = r.id;
  end loop;

  -- ── (B) Licences ────────────────────────────────────────────────
  for r in
    select l.id, l.farm_id, l.machine_id, l.type, l.number, l.expiry_date, l.reminder_lead_days,
           l.notified_status, l.last_notified_at, m.name as machine_name, f.settings
    from licences l
    join machines m on m.id = l.machine_id
    join farms f on f.id = l.farm_id
    where l.deleted_at is null
      and m.deleted_at is null and m.status not in ('retired','sold')
      and f.deleted_at is null and f.status in ('trial','active')
  loop
    v_status := app.expiry_status_of(
      r.expiry_date,
      coalesce(r.reminder_lead_days, (r.settings->>'licence_lead_days')::int, 30));

    if v_status is null or v_status = 'ok' then
      if r.notified_status is distinct from v_status then
        update licences set notified_status = v_status, last_notified_at = null where id = r.id;
      end if;
      continue;
    end if;

    v_should := (v_status is distinct from r.notified_status)
             or (v_status = 'expired' and r.notified_status = 'expired'
                 and r.last_notified_at is not null and r.last_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_template := case when v_status = 'expired' then 'licence_expired' else 'licence_expiring' end;
    v_payload  := jsonb_build_object(
      'licence_id',   r.id,
      'machine_id',   r.machine_id,
      'machine_name', r.machine_name,
      'licence_type', r.type,
      'number',       r.number,
      'status',       v_status,
      'expiry_date',  r.expiry_date
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, v_template, v_payload, v_deliver_after);
    update licences set notified_status = v_status, last_notified_at = now() where id = r.id;
  end loop;
end $$;

-- ── Lock down the app.* engine (0205 pattern) ─────────────────────
revoke execute on function app.enqueue_expiry_notifications() from public, anon, authenticated;
grant  execute on function app.enqueue_expiry_notifications() to service_role;

-- ── PostgREST-callable cron wrapper ───────────────────────────────
create or replace function public.cron_enqueue_expiry_notifications() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_expiry_notifications(); end $$;

revoke execute on function public.cron_enqueue_expiry_notifications() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_expiry_notifications() to service_role;
