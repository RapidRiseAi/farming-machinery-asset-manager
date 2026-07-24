-- 0311_work_requests_sync.sql
-- Keep the cost ledger + notifications in step with `work_requests` (0310).
--
-- 1) INVOICE → COST (no double-count). A work request's `invoice_amount_cents`
--    (ex-VAT) is booked into `cost_entries` as a single `invoice` row keyed by
--    (source_type='work_request', source_id=work_request.id). Because that key is
--    unique per request and the trigger UPSERTS (insert once, update thereafter,
--    soft-delete when the amount is cleared or the request is deleted), a request's
--    invoice appears in the ledger EXACTLY ONCE regardless of how many times it is
--    edited or re-fired — mirroring the 0211 machine/job_card_line sync idiom and
--    proven in rls_isolation.sql (F12b section). This is the ONLY path from a work
--    request to cost_entries: a QUOTE is recorded but never costed, and converting a
--    request to a job card (0310 job_card_id) books nothing here — the job card's own
--    lines cost through the 0211 job_card_line path — so the two never double-count.
--
-- 2) NOTIFY. Owner/manager are notified (in-app via app.notify_farm; push via F6's
--    delivery path) on every status change and whenever a quote or invoice amount is
--    first recorded/changed.
--
-- Both functions are SECURITY DEFINER (owned by a BYPASSRLS role) so they maintain the
-- ledger / queue regardless of the caller's RLS, writing only farm-scoped rows derived
-- from the source request's own farm_id.

-- ── Invoice amount → single `invoice` cost entry ──────────────────
create or replace function app_cost_from_work_request() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amount  bigint;
  v_deleted boolean;
begin
  v_amount  := coalesce(new.invoice_amount_cents, 0);   -- already ex-VAT
  v_deleted := new.deleted_at is not null;

  if v_deleted or v_amount <= 0 then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'work_request' and source_id = new.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'work_request' and source_id = new.id) then
    -- Update in place (keep the original occurred_on) so re-fires never duplicate.
    update cost_entries
       set farm_id = new.farm_id, machine_id = new.machine_id, type = 'invoice',
           amount_cents = v_amount, vat_rate_bps = new.vat_rate_bps,
           deleted_at = null, deleted_by = null
     where source_type = 'work_request' and source_id = new.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps,
                              source_type, source_id, occurred_on, created_by)
    values (new.farm_id, new.machine_id, 'invoice', v_amount, new.vat_rate_bps,
            'work_request', new.id, current_date, new.created_by);
  end if;

  return new;
end $$;

create trigger work_requests_cost
  after insert or update on work_requests
  for each row execute function app_cost_from_work_request();

-- ── Notify owner/manager on status / quote / invoice changes ──────
create or replace function app_work_request_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Status moved → notify the farm with the new status.
  if old.status is distinct from new.status then
    perform app.notify_farm(new.farm_id, 'work_request_status', jsonb_build_object(
      'work_request_id', new.id, 'machine_id', new.machine_id,
      'status', new.status, 'kind', new.kind));
  end if;

  -- A quote amount was recorded or changed → notify.
  if coalesce(new.quote_amount_cents, -1) is distinct from coalesce(old.quote_amount_cents, -1)
     and coalesce(new.quote_amount_cents, 0) > 0 then
    perform app.notify_farm(new.farm_id, 'work_request_quoted', jsonb_build_object(
      'work_request_id', new.id, 'machine_id', new.machine_id,
      'amount_cents', new.quote_amount_cents));
  end if;

  -- An invoice amount was recorded or changed → notify.
  if coalesce(new.invoice_amount_cents, -1) is distinct from coalesce(old.invoice_amount_cents, -1)
     and coalesce(new.invoice_amount_cents, 0) > 0 then
    perform app.notify_farm(new.farm_id, 'work_request_invoiced', jsonb_build_object(
      'work_request_id', new.id, 'machine_id', new.machine_id,
      'amount_cents', new.invoice_amount_cents));
  end if;

  return new;
end $$;

create trigger work_requests_notify
  after update on work_requests
  for each row execute function app_work_request_notify();

-- Trigger-only helpers: keep them off the PostgREST RPC surface (0205/0211 pattern).
revoke execute on function
  app_cost_from_work_request(),
  app_work_request_notify()
from anon, authenticated, public;
