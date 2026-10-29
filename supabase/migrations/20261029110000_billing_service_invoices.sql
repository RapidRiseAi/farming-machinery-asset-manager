-- Once-off services on an invoice: onboarding, installation, training, QR stickers
-- (founder decisions of 26 October 2026: "charge for onboarding, installations, training and
-- physical QR stickers"; QR generation is included, the stickers are a paid add-on; prices
-- are pending, so they are typed per invoice and the catalogue's prices may stay empty).
--
-- A service invoice is a kind of billing_invoices, built the way the AI-only invoice is
-- (20261010090000): the plan-shaped columns carry neutral values (no assets, no unit price,
-- one month, label 'Services') and the total comes from elsewhere, here the sum of its lines,
-- so nothing about the invoice freeze or its NOT NULL columns has to change.
--
-- It carries NO subscription, on purpose. That one choice keeps it out of three places it
-- must not reach: the nightly card charge (app.due_billing_charges joins the subscription, so
-- a farm's card is never charged for stickers without asking), the restore after payment
-- (which needs a subscription), and the pause for non-payment (app.farm_overdue_since only
-- counts subscription, plan-change, slot and AI invoices). It is paid by EFT, recorded by
-- hand, or through a payment link.

alter table public.billing_invoices drop constraint if exists billing_invoices_kind_ck;
alter table public.billing_invoices
  add constraint billing_invoices_kind_ck check (kind in ('period', 'proration', 'slots', 'ai_usage', 'service'));

create table if not exists public.billing_service_catalogue (
  code                  text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name_en               text not null check (btrim(name_en) <> ''),
  name_af               text not null check (btrim(name_af) <> ''),
  unit_en               text not null,
  unit_af               text not null,
  -- Null: priced per case (pending). Otherwise the default for a new line, editable on it.
  unit_price_incl_cents bigint check (unit_price_incl_cents is null or unit_price_incl_cents >= 0),
  active                boolean not null default true,
  sort                  integer not null default 0,
  updated_at            timestamptz not null default now()
);
alter table public.billing_service_catalogue enable row level security;
alter table public.billing_service_catalogue force row level security;
revoke all on public.billing_service_catalogue from public, anon, authenticated;
grant select on public.billing_service_catalogue to authenticated;
grant all on public.billing_service_catalogue to service_role;
drop policy if exists billing_service_catalogue_sel on public.billing_service_catalogue;
create policy billing_service_catalogue_sel on public.billing_service_catalogue
  for select to authenticated using ((select app.is_rr_admin()));
comment on table public.billing_service_catalogue is
  'Once-off services Rapid Rise invoices (20261029110000). Prices pending: typed per invoice.';

insert into public.billing_service_catalogue (code, name_en, name_af, unit_en, unit_af, sort) values
  ('onboarding',   'Onboarding and setup', 'Aanboording en opstelling', 'once', 'een keer', 10),
  ('installation', 'Device installation',  'Toestelinstallasie',        'device', 'toestel', 20),
  ('training',     'Training',             'Opleiding',                 'hour', 'uur', 30),
  ('qr_stickers',  'QR stickers',          'QR-plakkers',               'sheet', 'vel', 40)
on conflict (code) do nothing;

create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged;

  -- A SERVICE invoice (20261029110000) is the sum of its lines: onboarding, installation,
  -- training, QR stickers. No plan price, no subscription discount (a deal is a price on
  -- the plan, not on a sticker sheet), no AI use. Lines exist only once the draft has been
  -- assembled, so the total is right by the time the draft is issued.
  if new.kind = 'service' then
    new.discount_cents := 0;
    new.ai_usage_ex_vat_cents := 0;
    new.ai_usage_incl_cents := 0;
    new.total_incl_cents := coalesce(
      (select sum(l.line_total_incl_cents) from public.billing_invoice_lines l where l.invoice_id = new.id), 0);
    new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
    new.vat_cents := new.total_incl_cents - new.subtotal_ex_vat_cents;
    new.updated_at := now();
    return new;
  end if;

  -- Computed while it is a draft; kept verbatim afterwards. An issued invoice is a
  -- statement about a period that has been billed, and a discount that has since changed
  -- or expired must not restate it.
  if tg_op = 'INSERT' or new.status = 'draft' then
    v_discount := coalesce(
      app.billing_discount_cents(new.subscription_id, v_gross, new.period_start), 0);
    new.discount_cents := least(v_discount, v_gross);
    if new.discount_cents > 0 and new.discount_label is null then
      new.discount_label := (
        select coalesce(s.discount_label, s.discount_code)
          from public.billing_subscriptions s where s.id = new.subscription_id);
    end if;
  else
    new.discount_cents := least(coalesce(new.discount_cents, 0), v_gross);
  end if;

  -- AI and voice use (20261010090000), ex VAT on the header because the ledger is ex VAT.
  -- VAT at this invoice's own rate, which the VAT guard has already settled, and added
  -- AFTER the discount: a discount is a price on the plan, not on the provider's bill.
  new.ai_usage_ex_vat_cents := coalesce(new.ai_usage_ex_vat_cents, 0);
  new.ai_usage_incl_cents   := new.ai_usage_ex_vat_cents
    + round(new.ai_usage_ex_vat_cents::numeric * coalesce(new.vat_rate_bps, 0) / 10000)::bigint;

  new.total_incl_cents      := v_gross - new.discount_cents + new.ai_usage_incl_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;

-- Raise one. p_lines: [{code?, description, qty, unit_price_cents}], 1 to 20 lines.
create or replace function app.billing_raise_service_invoice(
  p_farm uuid, p_lines jsonb, p_due_on date, p_by uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  f public.farms%rowtype;
  v_set public.billing_settings%rowtype;
  v_invoice uuid;
  v_line jsonb;
  v_n integer := 0;
  v_qty integer;
  v_unit bigint;
  v_total bigint;
  v_desc text;
  v_rate integer;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin' and u.active) then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  select * into f from public.farms where id = p_farm and deleted_at is null;
  if not found then raise exception 'BILLING: no such farm' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 20 then
    raise exception 'BILLING: add between one and twenty lines' using errcode = '22023';
  end if;
  if p_due_on is not null and (p_due_on < current_date or p_due_on > current_date + 120) then
    raise exception 'BILLING: the due date must be within the next 120 days' using errcode = '22023';
  end if;
  select * into v_set from public.billing_settings where singleton;
  -- Not VAT-registered today: the VAT guard forces this, as on every invoice.
  v_rate := coalesce(v_set.vat_rate_bps, 0);

  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    f.id, null, app.next_billing_invoice_ref(), 'draft', 'service',
    current_date, current_date, current_date,
    coalesce(p_due_on, current_date + coalesce(v_set.payment_terms_days, 0)),
    f.plan, coalesce(f.billing_period, 'monthly'), 0, 0, 1,
    null, 'Services', v_rate,
    v_set.vat_number,
    jsonb_build_object(
      'legal_name', v_set.legal_name, 'trading_name', v_set.trading_name,
      'reg_number', v_set.reg_number, 'vat_registered', v_set.vat_registered,
      'billing_address', v_set.billing_address, 'billing_email', v_set.billing_email),
    jsonb_build_object(
      'name', f.name, 'trading_name', f.trading_name, 'reg_number', f.reg_number,
      'vat_number', f.vat_number, 'billing_address', f.billing_address, 'billing_email', f.billing_email)
  ) returning id into v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_desc := btrim(coalesce(v_line ->> 'description', ''));
    v_qty := (v_line ->> 'qty')::integer;
    v_unit := (v_line ->> 'unit_price_cents')::bigint;
    if v_desc = '' or length(v_desc) > 200 then
      raise exception 'BILLING: every line needs a description' using errcode = '22023';
    end if;
    if v_qty is null or v_qty < 1 or v_qty > 10000 then
      raise exception 'BILLING: a quantity must be from 1 to 10000' using errcode = '22023';
    end if;
    if v_unit is null or v_unit < 0 or v_unit > 100000000 then
      raise exception 'BILLING: a price must be from R0 to R1 000 000' using errcode = '22023';
    end if;
    v_total := v_qty * v_unit;
    insert into public.billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
      months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
    values (v_invoice, f.id, v_n, v_desc, v_qty, 1, v_unit, v_total,
      app.ex_vat_cents(v_total, v_rate), v_total - app.ex_vat_cents(v_total, v_rate));
    v_n := v_n + 1;
  end loop;

  update public.billing_invoices set status = 'open' where id = v_invoice;
  if (select total_incl_cents from public.billing_invoices where id = v_invoice) <= 0 then
    raise exception 'BILLING: an invoice for nothing is not sent' using errcode = '22023';
  end if;
  return v_invoice;
end;
$fn$;
revoke execute on function app.billing_raise_service_invoice(uuid, jsonb, date, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.billing_raise_service_invoice(p_farm uuid, p_lines jsonb, p_due_on date, p_by uuid)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_raise_service_invoice(p_farm, p_lines, p_due_on, p_by);
$$;
revoke execute on function public.billing_raise_service_invoice(uuid, jsonb, date, uuid) from public, anon, authenticated;
grant execute on function public.billing_raise_service_invoice(uuid, jsonb, date, uuid) to service_role;
