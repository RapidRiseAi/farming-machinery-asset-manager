-- 20260920150000_billing_discounts.sql
-- Founding Farmer pricing, and any deal done at a kitchen table.
--
-- `SCOPE.md` §12 sells a Founding Farmer rate "locked for life" to the first twenty farms,
-- and there has never been a way to give one. The only mechanism in the engine is price
-- PINNING (20260910160000), which grandfathers a farm onto the version it signed up at -
-- that keeps a price from rising, it does not make one lower. So every founding promise so
-- far is a promise the billing engine cannot keep.
--
-- TWO SHAPES, BECAUSE THE FOUNDER ASKED FOR BOTH
-- =============================================================================
--   * a PER-FARM discount, set by Rapid Rise on the subscription, the kitchen-table deal;
--   * a PROMO CODE entered at sign-up, which copies its discount onto the subscription.
--
-- A code is copied rather than referenced on purpose. "Locked for life" must not depend on
-- a row somebody might later edit or expire: once the farm has it, it is theirs, and
-- changing the code afterwards changes nothing for farms already on it.
--
-- WHERE IT IS APPLIED, AND WHY THERE
-- =============================================================================
-- In `app.billing_derive_invoice_totals`, the BEFORE trigger that already computes every
-- invoice total from its own snapshot. Three functions raise invoices, the nightly
-- generator, the plan-change proration and the quota-change proration, and patching each
-- would be three chances to forget, with a farm billed list price by whichever one was
-- missed. Deriving it in the trigger means an invoice cannot exist without its discount.
--
-- FROZEN WITH THE REST OF THE SNAPSHOT
-- =============================================================================
-- The discount is computed while the invoice is a DRAFT and then stays put. An issued
-- invoice is a statement about a period that has been billed; recomputing it later, when a
-- discount has since been changed or has expired, would silently restate a document the
-- customer has already been shown and possibly paid.

-- == What the farm was given =================================================
alter table public.billing_subscriptions
  add column if not exists discount_percent_bps integer,
  add column if not exists discount_fixed_cents bigint,
  add column if not exists discount_label text,
  -- Null means for as long as they are a customer: that is what "locked for life" means,
  -- and it is the default a Founding Farmer gets.
  add column if not exists discount_until date,
  add column if not exists discount_code text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'billing_subscriptions_discount_ck') then
    alter table public.billing_subscriptions
      add constraint billing_subscriptions_discount_ck check (
        -- One shape or the other, never both: two discounts on one line is an argument
        -- about which came first, in front of a customer.
        not (discount_percent_bps is not null and discount_fixed_cents is not null)
        and (discount_percent_bps is null or discount_percent_bps between 1 and 10000)
        and (discount_fixed_cents is null or discount_fixed_cents > 0)
      );
  end if;
end $$;

comment on column public.billing_subscriptions.discount_percent_bps is
  'Basis points off each invoice (2000 = 20%). Mutually exclusive with discount_fixed_cents.';
comment on column public.billing_subscriptions.discount_until is
  'Last day the discount applies. NULL = for as long as they are a customer.';

-- == What the invoice actually gave ==========================================
alter table public.billing_invoices
  add column if not exists discount_cents bigint not null default 0,
  add column if not exists discount_label text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'billing_invoices_discount_ck') then
    alter table public.billing_invoices
      add constraint billing_invoices_discount_ck check (discount_cents >= 0);
  end if;
end $$;

comment on column public.billing_invoices.discount_cents is
  'What came off this invoice, VAT-inclusive. Part of the frozen snapshot: the unit price '
  'above it is still the list price, so the document shows both what it costs and what '
  'they were given.';

-- == The rule, in one place ==================================================
create or replace function app.billing_discount_cents(
  p_subscription uuid, p_gross bigint, p_on date
) returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when p_gross is null or p_gross <= 0 then 0
           -- Expired: the deal had an end date and it has passed.
           when s.discount_until is not null and s.discount_until < coalesce(p_on, current_date) then 0
           when s.discount_percent_bps is not null then
             least(round(p_gross::numeric * s.discount_percent_bps / 10000)::bigint, p_gross)
           when s.discount_fixed_cents is not null then
             -- Never more than the invoice: a fixed discount larger than a small month's
             -- bill must not create a negative total, and it does not roll over either.
             least(s.discount_fixed_cents, p_gross)
           else 0
         end
    from public.billing_subscriptions s
   where s.id = p_subscription
     and s.deleted_at is null;
$$;

-- Granted to NOBODY. Its only caller is app.billing_derive_invoice_totals, which is
-- SECURITY DEFINER and therefore runs as the owner, so no role needs execute on this, and
-- the engine keeps its rule that app.* is reached through public.* wrappers or not at all.
-- The screen does not call it either: /billing mirrors this rule in TypeScript from the
-- subscription row it already reads, and a test pins the two together.
revoke execute on function app.billing_discount_cents(uuid, bigint, date)
  from public, anon, authenticated, service_role;

-- == Derive it with the rest of the money ====================================
create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged;

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

  new.total_incl_cents      := v_gross - new.discount_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;

-- == Promo codes =============================================================
create table if not exists public.billing_promo_codes (
  id                   uuid primary key default gen_random_uuid(),
  -- Stored upper-case and compared upper-case: a farmer typing "founding20" at six in the
  -- morning is entering the same code as the one on the offer sheet.
  code                 text not null unique,
  label                text not null,
  discount_percent_bps integer,
  discount_fixed_cents bigint,
  /** Null = no end date on the DEAL, i.e. the farms that take it keep it for life. */
  discount_until       date,
  /** Null = unlimited. The Founding Farmer offer is the first twenty farms. */
  max_uses             integer,
  used_count           integer not null default 0,
  expires_on           date,
  active               boolean not null default true,
  notes                text,
  created_by           uuid references public.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  deleted_by           uuid,
  constraint billing_promo_codes_code_ck check (code = upper(code) and length(code) between 3 and 40),
  constraint billing_promo_codes_shape_ck check (
    not (discount_percent_bps is not null and discount_fixed_cents is not null)
    and (discount_percent_bps is not null or discount_fixed_cents is not null)
    and (discount_percent_bps is null or discount_percent_bps between 1 and 10000)
    and (discount_fixed_cents is null or discount_fixed_cents > 0)
  ),
  constraint billing_promo_codes_uses_ck check (max_uses is null or max_uses > 0)
);

alter table public.billing_promo_codes enable row level security;
alter table public.billing_promo_codes force  row level security;

-- Rapid Rise owns the offers. A farm never reads the table: a code is checked by a
-- service-role function at sign-up, so nobody can list the codes or count what is left.
drop policy if exists billing_promo_codes_sel on public.billing_promo_codes;
create policy billing_promo_codes_sel on public.billing_promo_codes for select to authenticated
  using (app.is_rr_admin() and deleted_at is null);
drop policy if exists billing_promo_codes_all on public.billing_promo_codes;
create policy billing_promo_codes_all on public.billing_promo_codes for all to authenticated
  using (app.is_rr_admin()) with check (app.is_rr_admin());

grant select, insert, update, delete on public.billing_promo_codes to authenticated;
grant all on public.billing_promo_codes to service_role;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'billing_promo_codes_audit') then
    create trigger billing_promo_codes_audit
      after insert or update or delete on public.billing_promo_codes
      for each row execute function app_audit();
  end if;
end $$;

-- == Taking a code ===========================================================
-- Service-role only, and it answers in CODES, never in prose: the sign-up page turns the
-- answer into a sentence in the farmer's own language, and an unknown code must not tell a
-- stranger whether it exists.
create or replace function app.billing_take_promo_code(p_subscription uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  c public.billing_promo_codes%rowtype;
  s public.billing_subscriptions%rowtype;
begin
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'missing'); end if;

  select * into s from public.billing_subscriptions
   where id = p_subscription and deleted_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_subscription'); end if;
  -- One deal per farm. A second code would be an argument about which applies.
  if s.discount_percent_bps is not null or s.discount_fixed_cents is not null then
    return jsonb_build_object('ok', false, 'error', 'already_discounted');
  end if;

  -- Locked so two sign-ups cannot both take the twentieth place on the offer.
  select * into c from public.billing_promo_codes
   where code = v_code and deleted_at is null
   for update;
  if not found or not c.active then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;
  if c.expires_on is not null and c.expires_on < current_date then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'used_up');
  end if;

  update public.billing_subscriptions
     set discount_percent_bps = c.discount_percent_bps,
         discount_fixed_cents = c.discount_fixed_cents,
         discount_label       = c.label,
         discount_until       = c.discount_until,
         discount_code        = c.code,
         updated_at           = now()
   where id = p_subscription;

  update public.billing_promo_codes
     set used_count = used_count + 1, updated_at = now()
   where id = c.id;

  return jsonb_build_object(
    'ok', true, 'label', c.label,
    'percent_bps', c.discount_percent_bps, 'fixed_cents', c.discount_fixed_cents);
end $$;

-- Reached only through its public wrapper below, which is SECURITY DEFINER.
revoke execute on function app.billing_take_promo_code(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.billing_take_promo_code(p_subscription uuid, p_code text)
returns jsonb
language sql
security definer
set search_path = public, app, pg_temp
as $$
  select app.billing_take_promo_code(p_subscription, p_code);
$$;
revoke execute on function public.billing_take_promo_code(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_take_promo_code(uuid, text) to service_role;

-- == Rapid Rise setting one by hand ==========================================
-- The kitchen-table deal. SERVICE-ROLE ONLY, like every other write in this engine: the
-- action checks the role (rr_admin) and then calls through the service client, and the
-- grant is what makes that the only way in. An is_rr_admin() check inside would be worse
-- than useless, under the service client auth.uid() is null, so it would refuse the one
-- caller that is allowed.
create or replace function public.billing_set_subscription_discount(
  p_subscription uuid,
  p_percent_bps integer default null,
  p_fixed_cents bigint default null,
  p_label text default null,
  p_until date default null
) returns void
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
begin
  if p_percent_bps is not null and p_fixed_cents is not null then
    raise exception 'A discount is a percentage or an amount, not both.' using errcode = '22023';
  end if;
  if p_percent_bps is not null and (p_percent_bps < 1 or p_percent_bps > 10000) then
    raise exception 'A percentage discount must be between 0,01%% and 100%%.' using errcode = '22023';
  end if;
  if p_fixed_cents is not null and p_fixed_cents <= 0 then
    raise exception 'A fixed discount must be more than nothing.' using errcode = '22023';
  end if;

  update public.billing_subscriptions
     set discount_percent_bps = p_percent_bps,
         discount_fixed_cents = p_fixed_cents,
         discount_label       = nullif(btrim(coalesce(p_label, '')), ''),
         discount_until       = p_until,
         -- Set by hand, so it is no longer a code's doing.
         discount_code        = null,
         updated_at           = now()
   where id = p_subscription
     and deleted_at is null;
  if not found then
    raise exception 'Subscription not found.' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function public.billing_set_subscription_discount(uuid, integer, bigint, text, date)
  from public, anon, authenticated;
grant execute on function public.billing_set_subscription_discount(uuid, integer, bigint, text, date)
  to service_role;
