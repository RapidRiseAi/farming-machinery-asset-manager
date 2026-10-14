-- 20261014110000_test_farms.sql
-- Test farms stay out of Rapid Rise's totals (H5).
--
-- The click-through farm (scripts/seed_test_farm.mjs) is a real farm on production, so the
-- automatic checks run through the same row security a customer gets. That also made it
-- count as a customer: in the admin farm count, in the farms the billing console lists as
-- not paying yet, and in the AI revenue total. A farm marked `is_test` is left out of those.
-- Its AI cost still counts in the platform cost, because that money is spent.
--
-- Only Rapid Rise can change a farm row (policy farms_upd: app.is_rr_admin()), so a farm
-- cannot mark itself as a test farm to drop out of anything.

alter table public.farms add column if not exists is_test boolean not null default false;

comment on column public.farms.is_test is
  'A farm Rapid Rise uses for tests or demos, left out of the admin totals. Set by Rapid Rise only.';

-- Production's farms on 2026-10-14, every one a test farm (the founder confirmed the
-- Rapid Rise AI farm was a sign-up test). Elsewhere these ids do not exist.
update public.farms set is_test = true
 where id in ('f0000000-0000-4000-8000-00000000fa01',   -- Click-through Test Farm
              'aa000000-0000-0000-0000-000000000001',   -- Weltevrede Boerdery (demo seed)
              'aa000000-0000-0000-0000-000000000002',   -- Rooikoppies Plaas (demo seed)
              'e9afc350-685d-4078-8480-03f19726275f');  -- Rapid Rise AI (sign-up test)

-- The month's AI summary for /admin/ai: unchanged apart from the billed total, which is what
-- customers are charged and so leaves test farms out, and each farm's `is_test`.
create or replace function public.ai_admin_month(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin() then
    raise exception 'Platform admins only.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month', p_month,
    'platform_cost_usd', coalesce((select sum(provider_cost_usd) from public.ai_usage
                                    where month = p_month and credential in ('platform', 'internal')), 0),
    'billed_cents', coalesce((select sum(u.billed_cents) from public.ai_usage u
                                join public.farms f on f.id = u.farm_id
                               where u.month = p_month and not f.is_test), 0),
    'farms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'farm_id', x.farm_id, 'name', f.name, 'cost_usd', x.cost_usd, 'billed_cents', x.billed,
               'calls', x.calls, 'failed', x.failed, 'is_test', f.is_test) order by x.billed desc, x.cost_usd desc)
        from (select farm_id, sum(provider_cost_usd) as cost_usd, sum(billed_cents) as billed, count(*) as calls,
                     count(*) filter (where outcome not in ('ok', 'fallback')) as failed
                from public.ai_usage where month = p_month group by farm_id) x
        join public.farms f on f.id = x.farm_id), '[]'::jsonb)
  );
end $$;
