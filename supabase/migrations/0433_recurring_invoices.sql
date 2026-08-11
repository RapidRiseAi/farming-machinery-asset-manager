-- 0433_recurring_invoices.sql
-- The same invoice, every month, without anybody remembering to raise it.
--
-- A workshop on a monthly service contract, a supplier billing a standing retainer, a
-- storage or standby fee — the amount does not change and the date does not move, and
-- the failure mode is not getting it wrong, it is FORGETTING. Money that is never
-- invoiced is never collected, and nobody notices for months because there is nothing on
-- any screen to notice.
--
-- ── The shape ────────────────────────────────────────────────────────────────
--
-- A schedule holds everything an invoice needs (recipient, lines, terms) plus a cadence
-- and the date of the next one. The nightly cron walks the schedules that are due and
-- raises real documents through the same tables everything else uses — so a generated
-- invoice is an ordinary invoice in every respect: it has a number from the partner's own
-- sequence, its own lines, its own cost entry, its own place on a statement.
--
-- ── Two decisions worth stating ──────────────────────────────────────────────
--
-- 1. It generates a DRAFT by default. An invoice raised while nobody is looking, emailed
--    to a customer automatically, is how a business ends up billing a client it parted
--    ways with three months ago. `auto_send` exists for partners who want it, off by
--    default, and the screen says plainly which mode a schedule is in.
--
-- 2. It CANNOT run twice for the same period. `last_period_start` records the period a
--    run covered, and the generator skips a schedule whose next period is not past it —
--    so a cron that fires twice, a manual "run it now", or a retry after a half-finished
--    night cannot produce two invoices for October.

create type recurrence_cadence as enum ('weekly', 'monthly', 'quarterly', 'yearly');

create table recurring_invoices (
  id                 uuid primary key default gen_random_uuid(),
  workshop_id        uuid not null references workshops(id) on delete cascade,

  -- Who it bills. Exactly the three shapes a document has (0410): a linked farm, a client
  -- from the partner's own book, or a one-time name typed onto the schedule.
  farm_id            uuid references farms(id),
  partner_client_id  uuid references partner_clients(id),
  bill_to_name       text,

  name               text not null,             -- what the partner calls this schedule
  subject            text,                      -- what goes on the document
  notes              text,
  terms              text,
  machine_id         uuid,                      -- optional: a standing charge for one vehicle

  cadence            recurrence_cadence not null default 'monthly',
  -- The next invoice's ISSUE date. Moved forward by one cadence after each run.
  next_issue_date    date not null,
  -- Stop after this date, or never (null). A contract with an end date should not have to
  -- be remembered either.
  ends_on            date,
  -- The start of the period the LAST run covered. The idempotency key: a run is skipped
  -- unless the period it is about to raise is later than this one.
  last_period_start  date,
  last_document_id   uuid references partner_documents(id),

  vat_rate_bps       int not null default 1500,
  discount_cents     bigint not null default 0,
  -- Off by default. See note 1 above.
  auto_send          boolean not null default false,
  active             boolean not null default true,

  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid,

  -- Same recipient rule as a document: at most one structured recipient, and a name when
  -- there is neither.
  constraint recurring_invoices_recipient_ck check (
    (farm_id is not null and partner_client_id is null)
    or (farm_id is null and partner_client_id is not null)
    or (farm_id is null and partner_client_id is null and bill_to_name is not null)
  ),
  -- Only meaningful while the schedule is LIVE. When it reaches its end date the
  -- generator moves next_issue_date past ends_on and switches active off in the same
  -- update — that is the correct terminal state, and an unconditional check would refuse
  -- the very write that stops the schedule.
  constraint recurring_invoices_ends_ck check (
    ends_on is null or not active or ends_on >= next_issue_date
  )
);

create table recurring_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  recurring_id      uuid not null references recurring_invoices(id) on delete cascade,
  workshop_id       uuid not null references workshops(id) on delete cascade,
  sort_order        int  not null default 0,
  kind              job_line_kind not null default 'other',
  part_no           text,
  description       text not null,
  qty               numeric(12,3) not null default 1,
  unit_price_cents  bigint not null default 0,      -- ex-VAT, like every other line
  discount_cents    bigint not null default 0,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint recurring_invoice_lines_qty_ck check (qty >= 0)
);

create index recurring_invoices_due_idx on recurring_invoices(next_issue_date)
  where active and deleted_at is null;
create index recurring_invoices_workshop_idx on recurring_invoices(workshop_id, active);
create index recurring_invoice_lines_parent_idx on recurring_invoice_lines(recurring_id, sort_order);

comment on table recurring_invoices is
  'A standing invoice the nightly cron raises on a cadence (G8). Generates a DRAFT unless '
  '`auto_send`; `last_period_start` makes a run idempotent, so a double-fired cron cannot '
  'bill a customer twice for the same month.';

-- ── RLS: workshop-scoped, like the client book ───────────────────────────────
do $do$
declare t text;
begin
  foreach t in array array['recurring_invoices', 'recurring_invoice_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated '
                   'using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()))', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated '
                   'with check (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated '
                   'using (app.is_rr_admin() or workshop_id = app.user_workshop_id()) '
                   'with check (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated '
                   'using (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %1$I_audit after insert or update or delete on public.%1$I '
                   'for each row execute function app_audit()', t);
  end loop;
end $do$;

-- ── Moving a date on by one cadence ──────────────────────────────────────────
-- Its own function because month arithmetic is where this kind of feature goes wrong: the
-- 31st of January plus one month is the 28th of February, and a schedule that silently
-- drifts to the 1st of March bills on a different day every quarter. `+ interval '1 month'`
-- in Postgres already clamps to the end of a short month, which is the behaviour a
-- business expects — this wraps it so the rule lives in one place and is testable.
create or replace function app.advance_by_cadence(p_from date, p_cadence recurrence_cadence)
returns date
language sql immutable set search_path = public, pg_temp as $$
  select case p_cadence
    when 'weekly'    then p_from + interval '1 week'
    when 'monthly'   then p_from + interval '1 month'
    when 'quarterly' then p_from + interval '3 months'
    when 'yearly'    then p_from + interval '1 year'
  end::date;
$$;

-- ── The generator ────────────────────────────────────────────────────────────
-- SECURITY DEFINER because the nightly cron runs with no session, exactly like the other
-- 0205-pattern engines. It is never called from the client: execute is revoked from
-- authenticated and anon, and the partner-facing "run it now" goes through
-- `public.run_recurring_invoice`, which checks ownership first.
create or replace function app.generate_recurring_invoices(p_only uuid default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r          record;
  v_number   text;
  v_doc      uuid;
  v_period   date;
  v_terms    int;
  v_made     int := 0;
begin
  for r in
    select ri.*, w.invoice_terms_days
      from recurring_invoices ri
      join workshops w on w.id = ri.workshop_id
     where ri.deleted_at is null
       and ri.active
       and (p_only is null or ri.id = p_only)
       and ri.next_issue_date <= current_date
       and (ri.ends_on is null or ri.next_issue_date <= ri.ends_on)
       and (ri.farm_id is null or exists (
             select 1 from farms f
              where f.id = ri.farm_id and f.deleted_at is null and f.status in ('trial', 'active')))
  loop
    v_period := r.next_issue_date;

    -- Already done. A cron that fires twice, a retry after a half-finished night, or a
    -- partner pressing "run it now" on a schedule that already ran cannot bill twice.
    if r.last_period_start is not null and v_period <= r.last_period_start then
      update recurring_invoices
         set next_issue_date = app.advance_by_cadence(v_period, r.cadence), updated_at = now()
       where id = r.id;
      continue;
    end if;

    -- No lines means no invoice. Raising a zero-rand document every month would be worse
    -- than raising nothing, so the schedule is left alone for the partner to notice.
    if not exists (select 1 from recurring_invoice_lines l
                    where l.recurring_id = r.id and l.deleted_at is null) then
      continue;
    end if;

    v_number := app.next_document_number(r.workshop_id, 'invoice');
    v_terms  := coalesce(r.invoice_terms_days, 30);

    insert into partner_documents (
      farm_id, partner_client_id, workshop_id, machine_id, kind, status, source, number,
      subject, notes, terms, issue_date, due_date, vat_rate_bps, discount_cents,
      bill_to_name, created_by
    ) values (
      -- ALWAYS created as a draft, then flipped below if the schedule sends itself. The
      -- freeze triggers (0417) refuse lines on an issued document — correctly — so an
      -- invoice has to be assembled before it is issued, exactly like one built by hand.
      r.farm_id, r.partner_client_id, r.workshop_id, r.machine_id, 'invoice',
      'draft'::partner_doc_status,
      'built', v_number,
      r.subject, r.notes, r.terms, v_period, v_period + v_terms, r.vat_rate_bps, r.discount_cents,
      r.bill_to_name, r.created_by
    ) returning id into v_doc;

    insert into partner_document_lines (
      farm_id, document_id, sort_order, kind, part_no, description, qty, unit_price_cents, discount_cents
    )
    select r.farm_id, v_doc, l.sort_order, l.kind, l.part_no, l.description, l.qty,
           l.unit_price_cents, l.discount_cents
      from recurring_invoice_lines l
     where l.recurring_id = r.id and l.deleted_at is null
     order by l.sort_order;

    if r.auto_send then
      update partner_documents set status = 'sent', sent_at = now() where id = v_doc;
    end if;

    update recurring_invoices
       set last_period_start = v_period,
           last_document_id  = v_doc,
           next_issue_date   = app.advance_by_cadence(v_period, r.cadence),
           -- A schedule that has reached its end date stops rather than sitting due for ever.
           active            = case when r.ends_on is not null
                                     and app.advance_by_cadence(v_period, r.cadence) > r.ends_on
                                    then false else r.active end,
           updated_at        = now()
     where id = r.id;

    -- Tell the partner. A draft nobody knows about is the same as no invoice at all.
    perform app.notify_workshop(r.workshop_id, r.farm_id, 'recurring_raised', jsonb_build_object(
      'document_id', v_doc, 'number', v_number, 'schedule', r.name,
      'customer', r.bill_to_name, 'auto_sent', r.auto_send
    ), now());

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_recurring_invoices(uuid) from public, anon, authenticated;

create or replace function public.cron_generate_recurring_invoices() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return app.generate_recurring_invoices(null);
end $$;
revoke execute on function public.cron_generate_recurring_invoices() from public, anon, authenticated;
grant  execute on function public.cron_generate_recurring_invoices() to service_role;

-- ── "Raise it now" ───────────────────────────────────────────────────────────
-- The partner's own button, for the schedule they just set up and do not want to wait a
-- month to see work. Ownership is checked HERE rather than relying on the generator,
-- because the generator is SECURITY DEFINER and would otherwise honour any id passed to it.
create or replace function public.run_recurring_invoice(p_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_workshop uuid;
begin
  select workshop_id into v_workshop from recurring_invoices
   where id = p_id and deleted_at is null;
  if v_workshop is null then raise exception 'schedule not found' using errcode = 'P0002'; end if;

  if not app.is_rr_admin() and v_workshop is distinct from app.user_workshop_id() then
    raise exception 'That schedule belongs to another business.' using errcode = '42501';
  end if;

  return app.generate_recurring_invoices(p_id);
end $$;

revoke execute on function public.run_recurring_invoice(uuid) from public, anon;
grant  execute on function public.run_recurring_invoice(uuid) to authenticated, service_role;

comment on function public.run_recurring_invoice(uuid) is
  'Raise this schedule''s next invoice now. Ownership is checked here because the '
  'generator it calls is SECURITY DEFINER and would otherwise trust any id.';
