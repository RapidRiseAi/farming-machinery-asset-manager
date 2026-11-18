-- A4: optional services, immutable offers and explicit owner acceptance.
-- No existing quote, subscription, invoice, price or access is changed.
set lock_timeout = '3s';

alter table public.done_for_you_quotes add column if not exists service_terms jsonb;
alter table public.done_for_you_quotes add column if not exists accepted_by uuid;
alter table public.done_for_you_quotes alter column accepted_on drop not null;
create policy done_for_you_quotes_owner on public.done_for_you_quotes for select to authenticated
  using (app.effective_farm_role((select auth.uid()), farm_id) = 'owner' and service_terms is not null);

alter table public.billing_service_catalogue add column if not exists ready boolean not null default true;
alter table public.billing_service_catalogue add column if not exists supplier_quote_reference text;
insert into public.billing_service_catalogue(code,name_en,name_af,unit_en,unit_af,unit_price_incl_cents,sort,ready) values
 ('clean_setup','Clean spreadsheet setup','Opstelling uit netjiese sigblad','asset','bate',15000,50,true),
 ('document_capture','Document or photo capture','Vaslegging uit dokumente of fotos','asset','bate',30000,60,true),
 ('historical_work','Scoped historical or exceptional work','Afgebakende historiese of buitengewone werk','hour','uur',50000,70,true),
 ('remote_training','Remote training','Afstandopleiding','hour','uur',50000,80,true),
 ('onsite_training','On-site training','Opleiding op die perseel','visit','besoek',350000,90,true),
 ('qr_kits','Conditional QR kits','Voorwaardelike QR-stelle','asset','bate',4500,100,false)
on conflict (code) do nothing;

create table public.service_orders (
 id uuid primary key default gen_random_uuid(), farm_id uuid not null references public.farms(id),
 request_id uuid not null unique, quote_id uuid references public.done_for_you_quotes(id),
 kind text not null check(kind in ('managed','clean_setup','document_capture','historical_work','remote_training','onsite_training','qr_kits')),
 work_key text not null check(length(work_key) between 1 and 100),
 terms jsonb not null check(jsonb_typeof(terms)='object'),
 quantity numeric(10,2) not null check(quantity > 0),
 amount_incl_cents bigint not null check(amount_incl_cents > 0),
 currency text not null default 'ZAR' check(currency='ZAR'), vat_rate_bps integer not null,
 tax_snapshot jsonb not null, offered_by uuid not null references public.users(id),
 status text not null default 'offered' check(status in ('offered','accepted','completed','cancelled')),
 effective_from date not null, effective_until date, expires_on date not null,
 accepted_by uuid references public.users(id), accepted_at timestamptz,
 created_at timestamptz not null default now(),
 check(effective_until is null or effective_until >= effective_from),
 unique(id,farm_id)
);
create index service_orders_farm_created on public.service_orders(farm_id,created_at,id);
create table public.service_order_events (
 id uuid primary key default gen_random_uuid(), farm_id uuid not null,
 order_id uuid not null, request_id uuid not null unique,
 kind text not null check(kind in ('work','review')),
 minutes integer not null default 0 check(minutes between 0 and 1440),
 note text not null check(length(btrim(note)) between 1 and 4000), next_review_on date,
 recorded_by uuid not null references public.users(id), created_at timestamptz not null default now(),
 foreign key(order_id,farm_id) references public.service_orders(id,farm_id)
);
create index service_order_events_order on public.service_order_events(order_id,created_at,id);
create table public.service_order_invoices (
 id uuid primary key default gen_random_uuid(), farm_id uuid not null,
 order_id uuid not null, period_on date not null, invoice_id uuid not null references public.billing_invoices(id),
 created_at timestamptz not null default now(), unique(order_id,period_on),
 foreign key(order_id,farm_id) references public.service_orders(id,farm_id)
);
create index service_order_invoices_farm on public.service_order_invoices(farm_id);
do $$ declare t text; begin
 foreach t in array array['service_orders','service_order_events','service_order_invoices'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy service_owner_read on public.%I for select to authenticated using (app.is_rr_admin() or app.effective_farm_role((select auth.uid()),farm_id) = ''owner'')',t);
  execute format('create trigger service_audit after insert or update or delete on public.%I for each row execute function public.app_audit()',t);
  insert into app.audit_table_rules(table_name,scope,reason) values(t,'rapid_rise','Service agreement and work details are owner-only');
  perform app.pay_gate_apply(t);
 end loop;
end $$;

create function app.service_order_amount(p_kind text,p_quantity numeric,p_quoted bigint,p_travel bigint,p_period text)
returns bigint language plpgsql immutable set search_path=public,pg_temp as $$
begin
 if p_quantity is null or p_quantity<=0 or p_quantity>100000 or p_quantity<>round(p_quantity,2)
    or p_travel is null or p_travel<0 or p_travel>100000000 then raise exception 'service-invalid' using errcode='22023'; end if;
 if p_kind in ('clean_setup','document_capture','qr_kits','managed') and p_quantity<>trunc(p_quantity) then
  raise exception 'service-invalid' using errcode='22023'; end if;
 if p_kind<>'onsite_training' and p_travel<>0 then raise exception 'service-invalid' using errcode='22023'; end if;
 case p_kind
 when 'clean_setup' then return greatest(75000,p_quantity*15000)::bigint;
 when 'document_capture' then return greatest(150000,p_quantity*30000)::bigint;
 when 'historical_work','remote_training' then return round(p_quantity*50000)::bigint;
 when 'onsite_training' then
  if p_quantity<>1 or p_quoted is null or p_quoted<350000 then raise exception 'service-invalid' using errcode='22023'; end if;
  return p_quoted+p_travel;
 when 'qr_kits' then
  if p_quantity<10 then raise exception 'service-invalid' using errcode='22023'; end if;
  return (p_quantity*4500)::bigint;
 when 'managed' then
  if p_period not in ('monthly','annual') or p_period is null or p_quoted is null or p_quoted<=0
     or (p_period='monthly' and p_quoted<greatest(250000,p_quantity*17000)) then
   raise exception 'service-invalid' using errcode='22023'; end if;
  return p_quoted;
 else raise exception 'service-invalid' using errcode='22023';
 end case;
end $$;
revoke all on function app.service_order_amount(text,numeric,bigint,bigint,text) from public,anon,authenticated,service_role;

create function public.service_order_offer(p_farm uuid,p_request uuid,p_kind text,p_quantity numeric,p_terms jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_old public.service_orders; v_amount bigint; v_tax public.billing_settings;
 v_quote uuid; v_period text:=p_terms->>'period'; v_key text:=lower(btrim(p_terms->>'work_key')); k text;
begin
 if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 perform app.require_open_farm(p_farm,true);
 if p_request is null or p_terms is null or jsonb_typeof(p_terms)<>'object' or length(p_terms::text)>16000 then
  raise exception 'service-invalid' using errcode='22023'; end if;
 foreach k in array array['reference','scope','allowance','frequency','staff_owner','extras','assumptions','delivery','period','work_key'] loop
  if length(btrim(coalesce(p_terms->>k,''))) not between 1 and 2000 then raise exception 'service-invalid' using errcode='22023'; end if;
 end loop;
 if v_period not in ('once','monthly','annual') or (p_kind<>'managed' and v_period<>'once') then
  raise exception 'service-invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('service:'||p_farm,0));
 select * into v_old from public.service_orders where request_id=p_request;
 if found then
  if v_old.farm_id<>p_farm or v_old.kind<>p_kind or v_old.quantity<>p_quantity or v_old.terms<>p_terms then
   raise exception 'service-changed' using errcode='22023'; end if;
  return v_old.id;
 end if;
 if p_kind='qr_kits' and not exists(select 1 from public.billing_service_catalogue where code='qr_kits' and ready and active and nullif(btrim(supplier_quote_reference),'') is not null) then
  raise exception 'service-not-ready' using errcode='22023'; end if;
 if p_kind in ('clean_setup','document_capture') and exists(select 1 from public.service_orders
  where farm_id=p_farm and work_key=v_key and status<>'cancelled' and kind in ('clean_setup','document_capture')) then
  raise exception 'service-overlap' using errcode='22023'; end if;
 v_amount:=app.service_order_amount(p_kind,p_quantity,(p_terms->>'quoted_cents')::bigint,coalesce((p_terms->>'travel_cents')::bigint,0),v_period);
 if (p_terms->>'effective_from')::date < app.billing_today() or (p_terms->>'expires_on')::date < app.billing_today()
    or p_terms->>'effective_from' is null or p_terms->>'expires_on' is null then raise exception 'service-invalid' using errcode='22023'; end if;
 select * into v_tax from public.billing_settings where singleton;
 if p_kind='managed' then
  insert into public.done_for_you_quotes(farm_id,reference,per_vehicle_incl_cents,min_vehicles,billing_period,accepted_on,recorded_by,service_terms)
  values(p_farm,left(p_terms->>'reference',100),17000,0,v_period::public.billing_period,null,auth.uid(),p_terms||jsonb_build_object('recurring_incl_cents',v_amount,'currency','ZAR')) returning id into v_quote;
 end if;
 insert into public.service_orders(farm_id,request_id,quote_id,kind,work_key,terms,quantity,amount_incl_cents,vat_rate_bps,tax_snapshot,offered_by,effective_from,effective_until,expires_on)
 values(p_farm,p_request,v_quote,p_kind,v_key,p_terms,p_quantity,v_amount,
 case when v_tax.vat_registered then v_tax.vat_rate_bps else 0 end,
 jsonb_build_object('vat_registered',v_tax.vat_registered,'vat_number',v_tax.vat_number,'legal_name',v_tax.legal_name),auth.uid(),
 (p_terms->>'effective_from')::date,nullif(p_terms->>'effective_until','')::date,(p_terms->>'expires_on')::date) returning id into v_id;
 return v_id;
end $$;

create function public.service_order_accept(p_order uuid,p_amount bigint)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.service_orders;
begin
 select * into o from public.service_orders where id=p_order for update;
 if not found or app.effective_farm_role(auth.uid(),o.farm_id) is distinct from 'owner' then raise exception 'forbidden' using errcode='42501'; end if;
 perform app.require_open_farm(o.farm_id,true);
 if not app.farm_paid_extras_allowed(o.farm_id) then raise exception 'billing-grace-no-extras' using errcode='42501'; end if;
 if p_amount is distinct from o.amount_incl_cents then raise exception 'service-changed' using errcode='22023'; end if;
 if o.status='accepted' then return o.id; end if;
 if o.status<>'offered' or o.expires_on<app.billing_today() then raise exception 'service-expired' using errcode='22023'; end if;
 if o.kind='qr_kits' and not exists(select 1 from public.billing_service_catalogue where code='qr_kits' and ready and active and nullif(btrim(supplier_quote_reference),'') is not null) then raise exception 'service-not-ready' using errcode='22023'; end if;
 update public.service_orders set status='accepted',accepted_by=auth.uid(),accepted_at=now() where id=o.id;
 update public.done_for_you_quotes set accepted_by=auth.uid(),accepted_on=app.billing_today() where id=o.quote_id;
 return o.id;
end $$;

create function public.service_order_log(p_order uuid,p_request uuid,p_kind text,p_minutes integer,p_note text,p_next date default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.service_orders; e public.service_order_events;
begin
 if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into o from public.service_orders where id=p_order for update;
 if not found or o.status<>'accepted' then raise exception 'service-not-accepted' using errcode='22023'; end if;
 perform app.require_open_farm(o.farm_id,true);
 if p_kind='review' and p_minutes<>0 then raise exception 'service-invalid' using errcode='22023'; end if;
 select * into e from public.service_order_events where request_id=p_request;
 if found then
  if e.order_id<>p_order or e.kind<>p_kind or e.minutes<>p_minutes or e.note<>p_note or e.next_review_on is distinct from p_next then raise exception 'service-changed' using errcode='22023'; end if;
  return e.id;
 end if;
 insert into public.service_order_events(farm_id,order_id,request_id,kind,minutes,note,next_review_on,recorded_by)
 values(o.farm_id,o.id,p_request,p_kind,p_minutes,p_note,p_next,auth.uid()) returning id into e.id;
 return e.id;
end $$;

-- Staff issue only the accepted amount. One invoice per explicitly chosen service period;
-- no automatic card charging, subscription changes or invoices for logged extra time.
create function public.service_order_invoice(p_order uuid,p_period date)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.service_orders; v_id uuid; v_tax public.billing_settings; v_months integer;
begin
 if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into o from public.service_orders where id=p_order for update;
 if not found or o.status<>'accepted' then raise exception 'service-not-accepted' using errcode='22023'; end if;
 perform app.require_open_farm(o.farm_id,true);
 if not app.farm_paid_extras_allowed(o.farm_id) then raise exception 'billing-grace-no-extras' using errcode='42501'; end if;
 if p_period is null or p_period<o.effective_from or p_period>app.billing_today() or (o.effective_until is not null and p_period>o.effective_until) then raise exception 'service-invalid' using errcode='22023'; end if;
 v_months:=(extract(year from age(p_period,o.effective_from))*12+extract(month from age(p_period,o.effective_from)))::integer;
 if (o.terms->>'period'='once' and p_period<>o.effective_from)
 or (o.terms->>'period'='monthly' and (o.effective_from+make_interval(months=>v_months))::date<>p_period)
 or (o.terms->>'period'='annual' and (v_months%12<>0 or (o.effective_from+make_interval(months=>v_months))::date<>p_period)) then raise exception 'service-invalid' using errcode='22023'; end if;
 select invoice_id into v_id from public.service_order_invoices where order_id=o.id and period_on=p_period;
 if found then return v_id; end if;
 select * into v_tax from public.billing_settings where singleton;
 if o.vat_rate_bps<>case when v_tax.vat_registered then v_tax.vat_rate_bps else 0 end then raise exception 'service-changed' using errcode='22023'; end if;
 v_id:=app.billing_raise_service_invoice(o.farm_id,jsonb_build_array(jsonb_build_object('description',left(o.terms->>'reference',100)||' '||p_period::text,'qty',1,'unit_price_cents',o.amount_incl_cents)),null,auth.uid());
 insert into public.service_order_invoices(farm_id,order_id,period_on,invoice_id) values(o.farm_id,o.id,p_period,v_id);
 return v_id;
end $$;

do $$ declare f regprocedure; begin
 foreach f in array array['public.service_order_offer(uuid,uuid,text,numeric,jsonb)'::regprocedure,'public.service_order_accept(uuid,bigint)'::regprocedure,'public.service_order_log(uuid,uuid,text,integer,text,date)'::regprocedure,'public.service_order_invoice(uuid,date)'::regprocedure] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  execute format('grant execute on function %s to authenticated,service_role',f);
 end loop;
end $$;
reset lock_timeout;
