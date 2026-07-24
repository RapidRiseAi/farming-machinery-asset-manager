-- 0330_work_request_reminders.sql
-- F13: reminders for outstanding contractor QUOTES + INVOICES awaiting owner action.
--
-- The heart of the owner/manager activity inbox is that nothing a contractor sends
-- goes unanswered. The work-request notify trigger (0311) already fires once when a
-- quote or invoice is first recorded; this engine chases the STILL-OUTSTANDING ones so
-- an owner who missed the first alert is reminded (weekly, until they act).
--
-- Follows the 0205 pattern exactly:
--   * an app.* engine that is never PostgREST-reachable, EXECUTE revoked from
--     public/anon/authenticated and granted only to service_role;
--   * fronted by a public.cron_* wrapper the nightly route calls;
--   * retired/sold + soft-deleted machines never enqueue (Scope §4.1); soft-deleted
--     requests and non-active farms are excluded;
--   * quiet hours honoured via app.quiet_deliver_after (per-farm window);
--   * owner/manager targeting + in-app channel via the 0205 app.notify_farm overload.
--
-- "Awaiting owner action" is read straight off the lifecycle status:
--   * status = 'quoted'   → a contractor quote the owner has not yet accepted/declined;
--   * status = 'invoiced' → a contractor invoice the owner has not yet closed off.
-- Once the owner accepts (→ accepted / in_progress …) or closes the request, the status
-- leaves that set and reminders stop automatically — no per-row dedupe column needed.
--
-- Dedupe is read from the notification queue itself (the stale-meter idiom): at most one
-- reminder per request per 7 days, so it re-fires weekly while still outstanding but
-- never spams. Templates: `quote_awaiting`, `invoice_awaiting`.

create or replace function app.enqueue_work_request_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_template      text;
  v_amount        bigint;
  v_deliver_after timestamptz;
begin
  for r in
    select wr.id, wr.farm_id, wr.machine_id, wr.workshop_id, wr.status,
           wr.quote_amount_cents, wr.invoice_amount_cents,
           m.name as machine_name, w.name as workshop_name, f.settings
    from work_requests wr
    join machines m on m.id = wr.machine_id
    join farms    f on f.id = wr.farm_id
    left join workshops w on w.id = wr.workshop_id
    where wr.deleted_at is null
      and wr.status in ('quoted','invoiced')
      and m.deleted_at is null
      and m.status not in ('retired','sold')
      and f.deleted_at is null
      and f.status in ('trial','active')
  loop
    if r.status = 'quoted' then
      v_template := 'quote_awaiting';
      v_amount   := coalesce(r.quote_amount_cents, 0);
    else
      v_template := 'invoice_awaiting';
      v_amount   := coalesce(r.invoice_amount_cents, 0);
    end if;

    -- Weekly re-fire dedupe, read from the queue (no dedupe column): skip if this exact
    -- reminder was already queued for this request in the last 7 days.
    if exists (
      select 1 from notifications n
      where n.farm_id  = r.farm_id
        and n.template = v_template
        and n.payload->>'work_request_id' = r.id::text
        and n.created_at > now() - interval '7 days'
    ) then
      continue;
    end if;

    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, v_template, jsonb_build_object(
      'work_request_id', r.id,
      'machine_id',      r.machine_id,
      'machine_name',    r.machine_name,
      'workshop_id',     r.workshop_id,
      'workshop_name',   r.workshop_name,
      'amount_cents',    v_amount
    ), v_deliver_after);
  end loop;
end $$;

-- ── Lock down the app.* engine (0205 pattern) ─────────────────────
revoke execute on function app.enqueue_work_request_reminders() from public, anon, authenticated;
grant  execute on function app.enqueue_work_request_reminders() to service_role;

-- ── PostgREST-callable cron wrapper ───────────────────────────────
create or replace function public.cron_enqueue_work_request_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_work_request_reminders(); end $$;

revoke execute on function public.cron_enqueue_work_request_reminders() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_work_request_reminders() to service_role;
