-- 0423_write_off_behaviour.sql
-- What `written_off` actually does, now that the enum value exists (0422).
--
-- A written-off invoice is NOT cancelled. The work was done and the customer was billed;
-- what changed is that the money is not coming. So:
--
--   * it STAYS on the statement, at its full value, because it is part of what happened
--     on that account and hiding it would make the running balance unexplainable;
--   * it stops counting as OUTSTANDING, so the ageing stops carrying a number nobody is
--     ever going to collect;
--   * it stops being CHASED, for the same reason;
--   * and the farm's cost ledger keeps it — a farmer who never paid still had the work
--     done, and their machine's TCO should say so.
--
-- The write-off itself is a correction like any other: it needs a reason, and it goes
-- through `revise_document` so the version before it is kept. There is no separate
-- "write off" back door.

-- ── The reason, and who decided ──────────────────────────────────────────────
alter table partner_documents
  add column written_off_at     timestamptz,
  add column written_off_reason text;

alter table partner_documents
  add constraint partner_documents_writeoff_ck check (
    status <> 'written_off' or (written_off_reason is not null and length(btrim(written_off_reason)) >= 3)
  );

-- ── The cost ledger keeps it ─────────────────────────────────────────────────
-- The status list in the ledger trigger is what decides whether a farm's TCO counts a
-- partner invoice. `written_off` has to join it: the work WAS done on that machine and
-- the farm's cost of ownership should say so. Without this line the write-off would
-- silently soft-delete the cost entry, and a machine's lifetime spend would drop by the
-- amount of a bill somebody genuinely ran up.
create or replace function app_cost_from_partner_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_net bigint; v_live boolean; v_sign int;
begin
  if new.farm_id is null then
    return null;
  end if;

  v_net  := greatest(0, new.subtotal_cents - least(new.discount_cents, new.subtotal_cents));
  v_sign := case when new.kind = 'credit_note' then -1 else 1 end;
  v_live := new.deleted_at is null
        and new.kind in ('invoice', 'credit_note', 'debit_note')
        and new.status in ('sent', 'part_paid', 'paid', 'written_off')
        and v_net > 0;

  if not v_live then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'partner_document' and source_id = new.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'partner_document' and source_id = new.id) then
    update cost_entries
       set farm_id = new.farm_id, machine_id = new.machine_id, type = 'invoice',
           amount_cents = v_sign * v_net, vat_rate_bps = new.vat_rate_bps,
           deleted_at = null, deleted_by = null
     where source_type = 'partner_document' and source_id = new.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps,
                              source_type, source_id, occurred_on, created_by, note)
    values (new.farm_id, new.machine_id, 'invoice', v_sign * v_net, new.vat_rate_bps,
            'partner_document', new.id, new.issue_date, new.created_by, new.number);
  end if;

  if new.work_request_id is not null then
    if v_live and new.kind = 'invoice' then
      update cost_entries set deleted_at = coalesce(deleted_at, now())
        where source_type = 'work_request' and source_id = new.work_request_id and deleted_at is null;
    else
      update work_requests set updated_at = now() where id = new.work_request_id;
    end if;
  end if;

  return null;
end $$;

-- ── The payment rollup, with a refund in the mix ─────────────────────────────
-- Two things change now that a payment can be negative (0422) and an invoice can be
-- written off:
--
--   * refunding more than was ever paid would leave `amount_paid_cents` negative, which
--     reads on screen as a bill LARGER than its own total. Refused outright — a refund is
--     money going back, so there has to have been money.
--   * a write-off must survive payments moving underneath it. Left alone, the rollup
--     would recompute the status from whatever is now recorded and quietly put a
--     written-off invoice back into the ageing — deleting a refund would be enough to do
--     it. So a written-off invoice STAYS written off unless it is settled in FULL, which
--     is the one case where the write-off was simply wrong: they paid after all. (The
--     write-off credit on the statement is derived from what has been paid, so a part
--     payment on a written-off debt still leaves the account netting to zero.)
create or replace function app_partner_payment_rollup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_doc  uuid := coalesce(new.document_id, old.document_id);
  v_paid bigint;
begin
  select coalesce(sum(amount_cents), 0) into v_paid
    from partner_payments where document_id = v_doc and deleted_at is null;

  if v_paid < 0 then
    raise exception 'That refund is more than has ever been paid on this invoice.'
      using errcode = '23514';
  end if;

  update partner_documents d
     set amount_paid_cents = v_paid,
         status = case
           when d.kind <> 'invoice' or d.status in ('cancelled', 'draft') then d.status
           when d.status = 'written_off' and v_paid < d.total_cents then d.status
           when v_paid >= d.total_cents and d.total_cents > 0 then 'paid'
           when v_paid > 0 then 'part_paid'
           else 'sent'
         end,
         paid_at = case
           when d.kind = 'invoice' and v_paid >= d.total_cents and d.total_cents > 0
             then coalesce(d.paid_at, now())
           else null
         end,
         updated_at = now()
   where d.id = v_doc;

  return null;
end $$;

-- ── Ageing: stop chasing it ──────────────────────────────────────────────────
create or replace function app.partner_ageing(
  p_workshop uuid, p_farm uuid, p_client uuid, p_as_at date default current_date
) returns table (
  current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with invoices as (
    select d.id, d.total_cents
         + coalesce((select sum(n.total_cents) from partner_documents n
                      where n.corrects_document_id = d.id and n.kind = 'debit_note'
                        and n.deleted_at is null and n.status not in ('draft', 'void', 'cancelled')
                        and n.issue_date <= p_as_at), 0) as total_cents,
           coalesce(d.due_date, d.issue_date) as due,
           coalesce((select sum(p.amount_cents) from partner_payments p
                      where p.document_id = d.id and p.deleted_at is null
                        and p.paid_on <= p_as_at), 0)
         + coalesce((select sum(c.total_cents) from partner_documents c
                      where c.corrects_document_id = d.id and c.kind = 'credit_note'
                        and c.deleted_at is null and c.status not in ('draft', 'void', 'cancelled')
                        and c.issue_date <= p_as_at), 0) as settled
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.kind = 'invoice'
       and d.deleted_at is null
       -- `written_off` joins draft/void/cancelled here: still a real invoice on the
       -- statement, but no longer money anybody is waiting for.
       and d.status not in ('draft', 'void', 'cancelled', 'written_off')
       and d.issue_date <= p_as_at
       and ((p_farm   is not null and d.farm_id           = p_farm)
         or (p_client is not null and d.partner_client_id = p_client))
  ),
  outstanding as (
    select greatest(total_cents - settled, 0) as owed, p_as_at - due as days_over
      from invoices
     where total_cents > settled
  )
  select
    coalesce(sum(owed) filter (where days_over <= 0),               0)::bigint,
    coalesce(sum(owed) filter (where days_over between 1 and 30),   0)::bigint,
    coalesce(sum(owed) filter (where days_over between 31 and 60),  0)::bigint,
    coalesce(sum(owed) filter (where days_over > 60),               0)::bigint,
    coalesce(sum(owed),                                             0)::bigint
  from outstanding;
$$;

-- ── The statement ────────────────────────────────────────────────────────────
-- Three things it has to get right at once.
--
-- A WRITTEN-OFF invoice stays on the page at its full value — the customer really was
-- billed that, and deleting the line would make every number after it unexplainable. But
-- it cannot keep SITTING there as money owed, or the closing balance says a customer we
-- have given up on still owes forty thousand rand. So the write-off posts its own credit
-- line on the day it was decided, for whatever was still outstanding, and the account
-- nets to zero the way a real ledger does. Both halves of what happened, in order.
--
-- A REFUND is a negative payment, so `credit_cents` goes negative and the balance climbs
-- back — which is what actually happened when the money left the bank account.
--
-- And the OPENING balance has to carry all of it, otherwise a statement for one month
-- disagrees with a statement for the year.
create or replace function app.partner_statement(
  p_workshop uuid, p_farm uuid, p_client uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  document_id uuid, debit_cents bigint, credit_cents bigint, due_date date
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with scope as (
    select d.*
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.status not in ('draft', 'void', 'cancelled')
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and ((p_farm   is not null and d.farm_id           = p_farm)
         or (p_client is not null and d.partner_client_id = p_client))
  ),
  -- What was still owed on each written-off invoice at the moment it was written off:
  -- its total, less anything actually paid, less anything already credited back. That is
  -- the number that has to come off the account for the balance to be true.
  writeoffs as (
    select s.id,
           s.written_off_at::date as entry_date,
           s.number,
           greatest(0, s.total_cents
             - coalesce(s.amount_paid_cents, 0)
             - coalesce((select sum(c.total_cents) from partner_documents c
                          where c.corrects_document_id = s.id and c.kind = 'credit_note'
                            and c.deleted_at is null
                            and c.status not in ('draft', 'void', 'cancelled')), 0)) as cents
      from scope s
     where s.status = 'written_off' and s.written_off_at is not null
  ),
  opening as (
    select coalesce(sum(case when kind = 'credit_note' then -total_cents else total_cents end), 0)
             - coalesce((select sum(p.amount_cents)
                           from partner_payments p
                           join scope s2 on s2.id = p.document_id
                          where p.deleted_at is null and p.paid_on < p_from), 0)
             - coalesce((select sum(w.cents) from writeoffs w where w.entry_date < p_from), 0) as cents
      from scope
     where issue_date < p_from
  ),
  -- `description` carries the row's own DETAIL and nothing else — a document's subject, a
  -- payment's method, null where there is none. The sentence ("Payment received",
  -- "Written off as bad debt") is composed in `src/lib/statement.ts`, because a statement
  -- posted to an Afrikaans farm cannot have half its lines written in English by a
  -- Postgres function. `kind` is what tells the renderer which sentence to use.
  written_off_lines as (
    select w.entry_date,
           'write_off'::text as kind,
           w.number     as reference,
           null::text   as description,
           w.id         as document_id,
           0::bigint    as debit_cents,
           w.cents      as credit_cents,
           null::date   as due_date
      from writeoffs w
     where w.entry_date between p_from and p_to and w.cents > 0
  ),
  documents as (
    select issue_date as entry_date,
           kind::text as kind,
           number     as reference,
           subject    as description,
           id         as document_id,
           case when kind = 'credit_note' then 0 else total_cents end as debit_cents,
           case when kind = 'credit_note' then total_cents else 0 end as credit_cents,
           due_date
      from scope
     where issue_date between p_from and p_to
  ),
  payments as (
    select p.paid_on as entry_date,
           case when p.is_refund then 'refund' else 'payment' end as kind,
           coalesce(nullif(btrim(p.reference), ''), s.number) as reference,
           p.method  as description,
           s.id      as document_id,
           0::bigint as debit_cents,
           p.amount_cents as credit_cents,   -- negative for a refund; the balance climbs back
           null::date as due_date
      from partner_payments p
      join scope s on s.id = p.document_id
     where p.deleted_at is null
       and p.paid_on between p_from and p_to
  )
  select p_from, 'opening', null, null, null,
         greatest(o.cents, 0), greatest(-o.cents, 0), null
    from opening o
   where o.cents <> 0
  union all
  select * from documents
  union all
  select * from payments
  union all
  select * from written_off_lines
   order by 1, 2;
$$;

-- ── The chase: a written-off invoice is not chased ───────────────────────────
create or replace function app.enqueue_document_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; v_template text; v_deliver_after timestamptz; v_owed bigint;
begin
  for r in
    select d.id, d.farm_id, d.workshop_id, d.kind, d.status, d.number, d.due_date,
           d.total_cents, d.amount_paid_cents, d.bill_to_name,
           w.name as workshop_name, f.settings
      from partner_documents d
      join workshops w on w.id = d.workshop_id
      left join farms f on f.id = d.farm_id
     where d.deleted_at is null
       and d.status in ('sent', 'part_paid')
       and d.due_date is not null
       and (d.farm_id is null or (f.deleted_at is null and f.status in ('trial', 'active')))
  loop
    if r.kind = 'quote' then
      continue when r.due_date > current_date + 3 or r.due_date < current_date;
      v_template := 'quote_expiring';
    elsif r.kind = 'invoice' then
      v_owed := greatest(coalesce(r.total_cents, 0) - coalesce(r.amount_paid_cents, 0), 0);
      continue when v_owed <= 0;
      if r.due_date < current_date then
        v_template := 'invoice_overdue';
      elsif r.due_date <= current_date + 3 then
        v_template := 'invoice_due_soon';
      else
        continue;
      end if;
    else
      continue;
    end if;

    if exists (
      select 1 from notifications n
       where n.template in (v_template, v_template || '_partner')
         and n.payload->>'document_id' = r.id::text
         and n.created_at > now() - interval '7 days'
    ) then
      continue;
    end if;

    v_deliver_after := app.quiet_deliver_after(coalesce(r.settings, '{}'::jsonb));

    if r.farm_id is not null then
      perform app.notify_farm(r.farm_id, v_template, jsonb_build_object(
        'document_id', r.id, 'number', r.number, 'kind', r.kind,
        'due_date', r.due_date, 'amount', coalesce(v_owed, r.total_cents),
        'workshop', r.workshop_name
      ), v_deliver_after);
    end if;

    if v_template in ('invoice_overdue', 'quote_expiring') then
      perform app.notify_workshop(r.workshop_id, r.farm_id, v_template || '_partner', jsonb_build_object(
        'document_id', r.id, 'number', r.number, 'kind', r.kind,
        'due_date', r.due_date, 'amount', coalesce(v_owed, r.total_cents),
        'customer', r.bill_to_name
      ), v_deliver_after);
    end if;
  end loop;
end $$;

-- ── Writing one off goes through the correction machinery ────────────────────
-- Not a separate action with its own rules: a write-off is a change to an issued
-- document, so it keeps a version like every other change. `revise_document` cannot set
-- a status, so this is its sibling — same guard, same snapshot, same append-only history.
create or replace function public.write_off_document(p_document uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d partner_documents%rowtype; v_snapshot jsonb;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Say why it is being written off — it is what makes the decision readable later.'
      using errcode = '23514';
  end if;

  select * into d from partner_documents where id = p_document and deleted_at is null;
  if d.id is null then raise exception 'document not found' using errcode = 'P0002'; end if;

  if not app.is_rr_admin() and d.workshop_id is distinct from app.user_workshop_id() then
    raise exception 'Only the business that issued this invoice can write it off.' using errcode = '42501';
  end if;

  if d.kind <> 'invoice' then
    raise exception 'Only an invoice can be written off.' using errcode = '42501';
  end if;

  if d.status in ('draft', 'void', 'written_off') then
    raise exception 'This invoice is % — there is nothing to write off.', d.status using errcode = '42501';
  end if;

  v_snapshot := jsonb_build_object(
    'document', to_jsonb(d),
    'lines', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.sort_order)
        from partner_document_lines l
       where l.document_id = p_document and l.deleted_at is null
    ), '[]'::jsonb)
  );

  insert into partner_document_revisions
    (document_id, workshop_id, farm_id, version, reason, snapshot, total_cents_before, total_cents_after, edited_by)
  values (p_document, d.workshop_id, d.farm_id, d.revision,
          'Written off: ' || btrim(p_reason), v_snapshot, d.total_cents, d.total_cents, auth.uid());

  perform set_config('app.revising', 'on', true);
  update partner_documents set
    status             = 'written_off',
    written_off_at     = now(),
    written_off_reason = btrim(p_reason),
    revision           = revision + 1,
    updated_at         = now()
  where id = p_document;
  perform set_config('app.revising', 'off', true);
end $$;

revoke execute on function public.write_off_document(uuid, text) from public, anon;
grant  execute on function public.write_off_document(uuid, text) to authenticated, service_role;

comment on function public.write_off_document(uuid, text) is
  'The customer is not going to pay. The invoice stays on the statement at full value and '
  'in the farm''s cost ledger — the work was done — but stops counting as outstanding and '
  'stops being chased. Keeps a version, like every other change to an issued document.';
