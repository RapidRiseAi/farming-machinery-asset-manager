-- Make the farm's existing `settings.cost_visible_to_operators` choice real at the
-- database boundary.
--
-- Before this migration the setting was stored and rendered on /settings, but no RLS
-- policy consulted it: an operator could read the complete cost ledger, budgets and the
-- purchase / finance columns on every machine row available to them.  The app hiding a
-- number would not fix that because the same authenticated session can query PostgREST
-- directly.
--
-- There are two deliberately different controls below:
--   * row-level policies gate cost_entries and budgets for the resource farm;
--   * column privileges remove machine financial columns from ordinary table SELECTs.
--     Authorised callers read those columns through one checked RPC instead.
--
-- `app.effective_farm_role` is essential here. `users.role` describes the primary farm,
-- while a person can be an owner there and an operator on another site. The role on the
-- row's farm wins every time. Missing / malformed settings are fail-closed for operators.

create or replace function app.can_view_farm_costs(p_farm uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.user_role;
  v_visible boolean;
begin
  if p_farm is null then
    return false;
  end if;

  -- Trusted backend clients already bypass RLS and retain the table-level machine
  -- SELECT grant. Keep their explicit RPC use predictable as well.
  if auth.role() = 'service_role' then
    return true;
  end if;

  if not app.has_farm_access(p_farm) then
    return false;
  end if;

  if app.is_rr_admin() then
    return true;
  end if;

  -- Contractor cost access remains the per-link `see_costs` choice introduced by 0400.
  if app.current_app_role() = 'workshop' then
    return app.partner_scope(p_farm, 'costs');
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role in ('owner', 'manager', 'mechanic') then
    return true;
  end if;
  if v_role is distinct from 'operator' then
    return false;
  end if;

  select coalesce((f.settings -> 'cost_visible_to_operators') = 'true'::jsonb, false)
    into v_visible
    from public.farms f
   where f.id = p_farm
     and f.deleted_at is null;

  return coalesce(v_visible, false);
end
$$;

comment on function app.can_view_farm_costs(uuid) is
  'Whether the current caller may read costs for this resource farm. Owners, managers '
  'and mechanics are always allowed; an operator requires the farm JSON setting to be '
  'literal true; workshops retain their see_costs link grant. Uses effective per-farm role.';

revoke execute on function app.can_view_farm_costs(uuid)
  from public, anon;
grant execute on function app.can_view_farm_costs(uuid)
  to authenticated, service_role;

-- Public-schema wrapper for PostgREST / Server Components. SECURITY INVOKER is enough:
-- the app helper owns the privileged lookup and only answers for the current caller.
create or replace function public.can_view_farm_costs(p_farm uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select app.can_view_farm_costs(p_farm);
$$;

comment on function public.can_view_farm_costs(uuid) is
  'PostgREST-safe caller-scoped wrapper around app.can_view_farm_costs.';

revoke execute on function public.can_view_farm_costs(uuid)
  from public, anon;
grant execute on function public.can_view_farm_costs(uuid)
  to authenticated, service_role;

-- Preserve every pre-existing partner and tenancy predicate and add the farm-side cost
-- choice. Opted-in operators therefore keep the same ledger scope they had before; an
-- opted-out operator gets zero rows, including purchase and finance entries synced from
-- machines.
drop policy if exists cost_entries_sel on public.cost_entries;
create policy cost_entries_sel on public.cost_entries for select to authenticated
  using (
    deleted_at is null
    and app.has_farm_access(farm_id)
    and app.partner_scope(farm_id, 'costs')
    and app.partner_machine_visible(farm_id, machine_id)
    and app.can_view_farm_costs(farm_id)
  );

drop policy if exists budgets_sel on public.budgets;
create policy budgets_sel on public.budgets for select to authenticated
  using (
    deleted_at is null
    and app.has_farm_access(farm_id)
    and app.partner_scope(farm_id, 'costs')
    and app.partner_machine_visible(farm_id, machine_id)
    and app.can_view_farm_costs(farm_id)
  );

-- Audit diffs contain the old/new machine and cost-entry rows. Without this companion
-- restriction an opted-out operator could recover the same amounts from audit_log even
-- though the source tables were closed. Workshops keep their existing behaviour; this
-- migration changes only the effective operator branch.
drop policy if exists audit_sel on public.audit_log;
create policy audit_sel on public.audit_log for select to authenticated
  using (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.has_farm_access(farm_id)
      and (
        app.effective_farm_role(auth.uid(), farm_id) is distinct from 'operator'
        or app.can_view_farm_costs(farm_id)
      )
    )
  );

-- RLS cannot hide individual columns. Remove the table-level SELECT inherited from
-- 0102, then grant every non-financial column explicitly. INSERT/UPDATE/DELETE grants
-- and their RLS policies are unchanged. New machine columns will intentionally require
-- an explicit review before they become readable to browser clients.
revoke select on table public.machines from authenticated;

do $grant_safe_machine_columns$
declare
  v_columns text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into v_columns
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.machines'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname <> all (array[
       'purchase_price_cents',
       'supplier',
       'finance_provider',
       'finance_total_cents',
       'finance_monthly_cents',
       'finance_term_months',
       'finance_interest_bps'
     ]);

  if v_columns is null then
    raise exception 'cannot grant safe machine columns: public.machines has no columns';
  end if;

  execute format('grant select (%s) on table public.machines to authenticated', v_columns);
end
$grant_safe_machine_columns$;

-- The only browser-readable path to machine financials. Every condition is repeated
-- inside this SECURITY DEFINER function because it bypasses machines RLS:
--   1. cost visibility on the machine's own farm;
--   2. normal assigned/partner machine visibility, or the additive full-fleet grant;
--   3. live row only.
create or replace function public.machine_financials(p_machine uuid)
returns table (
  machine_id uuid,
  farm_id uuid,
  purchase_price_cents bigint,
  supplier text,
  finance_provider text,
  finance_total_cents bigint,
  finance_monthly_cents bigint,
  finance_term_months integer,
  finance_interest_bps integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    m.id,
    m.farm_id,
    m.purchase_price_cents,
    m.supplier,
    m.finance_provider,
    m.finance_total_cents,
    m.finance_monthly_cents,
    m.finance_term_months,
    m.finance_interest_bps
  from public.machines m
  where m.id = p_machine
    and m.deleted_at is null
    and app.can_view_farm_costs(m.farm_id)
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    );
$$;

comment on function public.machine_financials(uuid) is
  'Caller-scoped financial projection for one visible machine. Replaces direct browser '
  'SELECT access to purchase price, supplier and finance columns.';

revoke execute on function public.machine_financials(uuid)
  from public, anon;
grant execute on function public.machine_financials(uuid)
  to authenticated, service_role;
