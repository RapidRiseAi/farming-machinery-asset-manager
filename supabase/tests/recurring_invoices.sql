\set ON_ERROR_STOP on
-- Recurring invoices raise once per period (0433, 20261026090000): the generator raises one
-- invoice for a due schedule, a second run (the cron twice, or "raise it now" after the cron)
-- raises nothing more, and the loop takes a lock on each schedule so two runs at the same
-- moment cannot both bill it.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e3000000-0000-4000-9000-000000000001', 'Recurring customer', 'complete', 'active', 'monthly');
insert into public.workshops (id, name) values
  ('e3100000-0000-4000-9000-000000000001', 'Recurring workshop');

insert into public.recurring_invoices (id, workshop_id, farm_id, bill_to_name, name, cadence, next_issue_date)
values ('e3200000-0000-4000-9000-000000000001', 'e3100000-0000-4000-9000-000000000001',
        'e3000000-0000-4000-9000-000000000001', 'Recurring customer', 'Monthly service', 'monthly',
        current_date);
insert into public.recurring_invoice_lines (recurring_id, workshop_id, description, qty, unit_price_cents)
values ('e3200000-0000-4000-9000-000000000001', 'e3100000-0000-4000-9000-000000000001', 'Service plan', 1, 50000);

do $t$
declare made int; second int; docs int; def text;
begin
  def := pg_get_functiondef('app.generate_recurring_invoices(uuid)'::regprocedure);
  if position('for update of ri' in def) = 0 then
    raise exception 'the generator must lock each schedule it raises (for update of ri)';
  end if;

  made := app.generate_recurring_invoices(null);
  second := app.generate_recurring_invoices(null);
  select count(*) into docs from public.partner_documents
   where workshop_id = 'e3100000-0000-4000-9000-000000000001' and kind = 'invoice';
  if made <> 1 or second <> 0 or docs <> 1 then
    raise exception 'expected one invoice from two runs, got made=% second=% docs=%', made, second, docs;
  end if;
  if (select next_issue_date from public.recurring_invoices where id = 'e3200000-0000-4000-9000-000000000001')
     <= current_date then
    raise exception 'the schedule should have moved on to its next period';
  end if;
end $t$;

rollback;
