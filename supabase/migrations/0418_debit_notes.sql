-- 0418_debit_notes.sql
-- The other half of an adjustment: the invoice was too LOW.
--
-- AutoVault carries both (`invoice_adjustments.note_type` is 'credit' or 'debit'); we
-- shipped only the credit half, so overcharging had an answer and undercharging had none
-- — a partner who left a part off an invoice could either edit it (which 0412 refused) or
-- raise a second invoice that looks unrelated on the customer's statement.
--
-- A debit note is a credit note with the sign flipped, everywhere: its own number series,
-- POSITIVE in the farm's cost ledger, a DEBIT on the statement, and counted in what is
-- owed. Every place that special-cased `credit_note` now handles the pair, so there is no
-- third code path to keep in step.

alter table workshops
  add column doc_prefix_debit text not null default 'DN',
  add column next_debit_no    int  not null default 1;

comment on column workshops.doc_prefix_debit is
  'Numbering prefix for debit notes — its own series, like the credit notes in 0415.';

update workshops w set next_debit_no = greatest(
  w.next_debit_no,
  coalesce((
    select max(nullif(regexp_replace(d.number, '^.*?(\d+)$', '\1'), '')::int) + 1
      from partner_documents d
     where d.workshop_id = w.id and d.kind = 'debit_note' and d.number ~ '\d+$'
  ), 1)
);

-- ── Numbering ────────────────────────────────────────────────────────────────
create or replace function app.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_no int; v_prefix text; v_number text; v_taken boolean; v_guard int := 0;
begin
  if p_kind not in ('quote', 'invoice', 'credit_note', 'debit_note') then
    raise exception 'unknown document kind %', p_kind;
  end if;

  loop
    v_guard := v_guard + 1;
    if v_guard > 10000 then
      raise exception 'could not allocate a % number for workshop % — the sequence looks corrupt', p_kind, p_workshop;
    end if;

    if p_kind = 'quote' then
      update workshops set next_quote_no = next_quote_no + 1
        where id = p_workshop returning next_quote_no - 1, doc_prefix_quote into v_no, v_prefix;
    elsif p_kind = 'credit_note' then
      update workshops set next_credit_no = next_credit_no + 1
        where id = p_workshop returning next_credit_no - 1, doc_prefix_credit into v_no, v_prefix;
    elsif p_kind = 'debit_note' then
      update workshops set next_debit_no = next_debit_no + 1
        where id = p_workshop returning next_debit_no - 1, doc_prefix_debit into v_no, v_prefix;
    else
      update workshops set next_invoice_no = next_invoice_no + 1
        where id = p_workshop returning next_invoice_no - 1, doc_prefix_invoice into v_no, v_prefix;
    end if;

    if v_no is null then raise exception 'unknown workshop %', p_workshop; end if;

    v_number := coalesce(nullif(v_prefix, ''), 'DOC') || '-' || lpad(v_no::text, 4, '0');

    select exists (
      select 1 from partner_documents
       where workshop_id = p_workshop and kind = p_kind::partner_doc_kind and number = v_number
    ) into v_taken;

    exit when not v_taken;
  end loop;

  return v_number;
end $$;

create or replace function public.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_rr_admin() or p_workshop = app.user_workshop_id()) then
    raise exception 'not your numbering sequence';
  end if;
  if p_kind not in ('quote', 'invoice', 'credit_note', 'debit_note') then
    raise exception 'unknown document kind %', p_kind;
  end if;
  return app.next_document_number(p_workshop, p_kind);
end $$;

revoke execute on function public.next_document_number(uuid, text) from public, anon;
grant  execute on function public.next_document_number(uuid, text) to authenticated;

-- ── Both notes must name what they adjust ────────────────────────────────────
alter table partner_documents drop constraint partner_documents_credit_ck;
alter table partner_documents
  add constraint partner_documents_note_ck check (
    kind not in ('credit_note', 'debit_note') or corrects_document_id is not null
  );

-- ── The ledger: credit subtracts, debit adds ─────────────────────────────────
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
        and new.status in ('sent', 'part_paid', 'paid')
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

-- ── The cap applies to credits only ──────────────────────────────────────────
-- Crediting more than the invoice hands the customer a negative balance nothing explains.
-- DEBITING more is merely unusual (a badly under-quoted job), so it is allowed.
create or replace function app_partner_credit_within_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_invoice bigint; v_credited bigint;
begin
  if new.kind <> 'credit_note' or new.status in ('draft', 'void') then
    return new;
  end if;

  select total_cents into v_invoice from partner_documents where id = new.corrects_document_id;

  select coalesce(sum(total_cents), 0) into v_credited from partner_documents
   where corrects_document_id = new.corrects_document_id
     and kind = 'credit_note' and id <> new.id
     and deleted_at is null and status not in ('draft', 'void');

  if v_invoice is not null and v_credited + new.total_cents > v_invoice then
    raise exception 'Credit notes against this invoice would come to more than the invoice itself (% of %).',
      v_credited + new.total_cents, v_invoice using errcode = '23514';
  end if;
  return new;
end $$;

-- ── The statement: a debit note is a debit ───────────────────────────────────
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
  opening as (
    select coalesce(sum(case when kind = 'credit_note' then -total_cents else total_cents end), 0)
             - coalesce((select sum(p.amount_cents)
                           from partner_payments p
                           join scope s2 on s2.id = p.document_id
                          where p.deleted_at is null and p.paid_on < p_from), 0) as cents
      from scope
     where issue_date < p_from
  ),
  documents as (
    select issue_date as entry_date,
           kind::text as kind,
           number     as reference,
           coalesce(subject, case kind when 'credit_note' then 'Credit note'
                                       when 'debit_note'  then 'Debit note'
                                       else 'Invoice' end) as description,
           id         as document_id,
           case when kind = 'credit_note' then 0 else total_cents end as debit_cents,
           case when kind = 'credit_note' then total_cents else 0 end as credit_cents,
           due_date
      from scope
     where issue_date between p_from and p_to
  ),
  payments as (
    select p.paid_on as entry_date,
           'payment' as kind,
           coalesce(nullif(btrim(p.reference), ''), s.number) as reference,
           case when p.method is null then 'Payment received'
                else 'Payment received (' || p.method || ')' end as description,
           s.id      as document_id,
           0::bigint as debit_cents,
           p.amount_cents as credit_cents,
           null::date as due_date
      from partner_payments p
      join scope s on s.id = p.document_id
     where p.deleted_at is null
       and p.paid_on between p_from and p_to
  )
  select p_from, 'opening', null, 'Balance brought forward', null,
         greatest(o.cents, 0), greatest(-o.cents, 0), null
    from opening o
   where o.cents <> 0
  union all
  select * from documents
  union all
  select * from payments
   order by 1, 2;
$$;

-- ── The ageing: a debit note ages with the invoice it belongs to ─────────────
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
       and d.status not in ('draft', 'void', 'cancelled')
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

-- ── The chase skips both notes ───────────────────────────────────────────────
-- Neither note is an outstanding item of its own: a credit note owes nothing, and a debit
-- note is chased through the invoice it belongs to, which the ageing above now includes.
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
