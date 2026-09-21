-- 20260920160000_signup_promo_code.sql
-- A promo code entered at sign-up must discount the FIRST invoice, not the second.
--
-- 20260920150000 gave the engine discounts and a function that takes a code. Applying that
-- from the sign-up route after `billing_create_pending_signup` returned would have been
-- wrong in a way nobody would notice until a Founding Farmer read their first receipt:
-- that function creates the subscription AND raises the first invoice in one transaction,
-- and by the time it returns the invoice is `open`. The discount is frozen at draft — on
-- purpose, so a deal that changes later cannot restate a document somebody has paid — so a
-- code applied afterwards takes effect from the SECOND period and the farm pays list price
-- for the one thing they entered the code for.
--
-- So the code travels INTO the transaction. The subscription gets its discount between
-- being created and being invoiced, which is the only window where it can reach the
-- invoice the visitor is about to be shown at checkout.
--
-- THE OLD SIGNATURE IS DROPPED, NOT LEFT
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgREST resolves overloads by argument NAME, and a defaulted parameter added beside an
-- existing function makes every call ambiguous — `billing_create_pending_signup` would
-- start failing for the seven-argument callers it already has. Both arities cannot exist,
-- so the seven-argument pair goes.

-- ── Is this code any good? ──────────────────────────────────────────────────
-- Read-only, takes nothing, locks nothing. The sign-up route calls this BEFORE creating an
-- auth user, so somebody who mistypes a code gets a sentence instead of a half-made
-- account — and the authoritative take still happens under lock inside the transaction,
-- because between this answer and that commit the last place on an offer can go.
create or replace function app.billing_check_promo_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  c public.billing_promo_codes%rowtype;
begin
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'missing'); end if;

  select * into c from public.billing_promo_codes
   where code = v_code and deleted_at is null;

  -- One answer for "no such code" and for "switched off". A stranger trying codes must not
  -- be able to learn which ones exist.
  if not found or not c.active then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;
  if c.expires_on is not null and c.expires_on < current_date then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'used_up');
  end if;

  return jsonb_build_object(
    'ok', true, 'code', c.code, 'label', c.label,
    'percent_bps', c.discount_percent_bps, 'fixed_cents', c.discount_fixed_cents,
    'until', c.discount_until);
end $$;
revoke execute on function app.billing_check_promo_code(text)
  from public, anon, authenticated, service_role;

create or replace function public.billing_check_promo_code(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select app.billing_check_promo_code(p_code);
$$;
revoke execute on function public.billing_check_promo_code(text) from public, anon, authenticated;
grant  execute on function public.billing_check_promo_code(text) to service_role;

comment on function public.billing_check_promo_code(text) is
  'Does this promo code still work? Read-only and takes nothing — the sign-up route asks '
  'before it creates anything so a typo is a sentence, not an orphaned auth user. Answers '
  'in codes, never prose.';

-- ── Sign-up, now with a code in the transaction ─────────────────────────────
drop function if exists public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer);
drop function if exists app.create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer);

create or replace function app.create_pending_signup(
  p_user       uuid,     -- already created in auth.users by the caller
  p_email      text,
  p_name       text,     -- the person
  p_farm_name  text,
  p_plan       farm_plan,
  p_period     billing_period,
  p_quota      integer,
  p_promo_code text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm  uuid;
  v_sub   uuid;
  v_price public.billing_price_versions%rowtype;
  v_promo jsonb;
begin
  if p_quota is null or p_quota < 1 then
    raise exception 'SIGNUP: choose at least one vehicle' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_farm_name), '') = '' then
    raise exception 'SIGNUP: the farm needs a name' using errcode = 'check_violation';
  end if;

  -- Never invent a price. A plan with no active price version is either bespoke
  -- (price-on-application) or one nobody has priced yet, and signing somebody up for it
  -- would produce a farm that can never be invoiced and therefore never opened.
  select * into v_price from app.billing_active_price(p_plan, p_period);
  if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
    raise exception 'SIGNUP: that plan is not available to buy online'
      using errcode = 'check_violation';
  end if;

  insert into public.farms (name, plan, status, billing_period, billing_email)
  values (btrim(p_farm_name), p_plan, 'active', p_period, lower(btrim(p_email)))
  returning id into v_farm;

  insert into public.users (id, farm_id, workshop_id, role, name, email, active)
  values (p_user, v_farm, null, 'owner',
          nullif(btrim(p_name), ''), lower(btrim(p_email)), true);

  -- next_billing_on = today so the generator below picks it up immediately; the period
  -- columns stay NULL so the first BILLED period starts when billing starts, which is the
  -- same rule app.start_billing_subscription follows.
  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on,
    anchor_day, asset_quota, created_by
  ) values (
    v_farm, p_plan, p_period, 'pending',
    null, null, current_date,
    extract(day from current_date)::integer, p_quota, p_user
  )
  returning id into v_sub;

  -- BEFORE the invoice, or it does not reach the invoice. The take is the authoritative
  -- one: it locks the code's row, so two people racing for the twentieth Founding Farmer
  -- place cannot both get it, and the used_count it increments rolls back with everything
  -- else if the rest of this fails.
  --
  -- A bad code ABORTS the sign-up rather than quietly proceeding at list price. Somebody
  -- who typed a code believes they are buying at a different price, and taking their money
  -- at the higher one because the code was wrong is the version of this they would be
  -- entitled to be angry about.
  if coalesce(btrim(p_promo_code), '') <> '' then
    v_promo := app.billing_take_promo_code(v_sub, p_promo_code);
    if not coalesce((v_promo->>'ok')::boolean, false) then
      raise exception 'SIGNUP_PROMO:%', coalesce(v_promo->>'error', 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;

  -- The invoice they are about to pay. Inside the same transaction, so a sign-up either
  -- produces a farm with something to pay or produces nothing at all.
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'SIGNUP: could not raise the first invoice' using errcode = 'check_violation';
  end if;

  return v_sub;
end $$;
revoke execute on function app.create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer, text)
  from public, anon, authenticated;

comment on function app.create_pending_signup(uuid, text, text, text, farm_plan, billing_period, integer, text) is
  'Self-serve sign-up, in one transaction: farm, owner, pending subscription, any promo '
  'code, and the first invoice — in that order, so the code reaches the invoice being paid. '
  'The auth.users row is the caller''s job and must be created FIRST and removed if this '
  'raises. Grants no access — app.farm_billing_gate keeps the farm shut until the invoice '
  'is paid.';

create or replace function public.billing_create_pending_signup(
  p_user       uuid,
  p_email      text,
  p_name       text,
  p_farm_name  text,
  p_plan       farm_plan,
  p_period     billing_period,
  p_quota      integer,
  p_promo_code text default null
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.create_pending_signup(p_user, p_email, p_name, p_farm_name,
                                   p_plan, p_period, p_quota, p_promo_code);
$$;
-- service_role ONLY. The sign-up route runs with the service key because an anonymous
-- visitor has no database access at all in this product, and a wrapper a browser could
-- call would let anybody mint farms and owners.
revoke execute on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer, text)
  from public, anon, authenticated;
grant  execute on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer, text) to service_role;
