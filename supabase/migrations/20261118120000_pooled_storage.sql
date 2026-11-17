-- 20261118120000_pooled_storage.sql
-- Pooled attachment storage for each customer, warnings before it fills, and optional paid
-- 10 GB blocks (BRIEF section 11; decisions 14, 15, 22 and 34; scenarios 24, 25 and 26).
--
-- == The allowance ===========================================================================
-- One pool per customer subscription: the billing site (app.billing_root) and every site billed
-- through it share it, in decimal bytes:
--   included = max(2,000,000,000, full spaces x 100,000,000 + equipment spaces x 25,000,000)
--   total    = included + paid blocks x 10,000,000,000
-- Full spaces are the purchased full capacity (at least the price's minimum; a metered
-- subscription counts what is in use). Equipment spaces are the plan's included equipment plus
-- the extra equipment paid for, so the free spaces count too (decision 14). It is one shared
-- allowance, never a per-asset cap. The next renewal's allowance is worked out from the pending
-- quantities and shown beside it, so a scheduled reduction is visible before it lands.
-- app.storage_quota_overrides (Rapid Rise, by hand) still wins where it has a row.
--
-- == What counts against it ==================================================================
-- Every physical stored copy in the customer's folders (the first path segment is the site id),
-- in every bucket except contractors' books (partner-*), Rapid Rise's billing proofs, menu media
-- and the temporary command audio, which its own sweep removes (20261115100000), so it cannot
-- become a permanent unmetered attachment. Concretely:
--   finalised pipeline files not yet removed + reservations of uploads in flight (B1's ledger)
--   + objects with no upload intent at all (files from before the pipeline, the older upload
--     paths still allowed while app.upload_settings.enforce_reserved_paths is off, and orphans).
-- The last part is measured nightly (public.cron_storage_measure) into storage_usage_snapshots,
-- one row per site per South African day, which is also the record of usage for each billing
-- period: today's storage is never used to reconstruct a past month.
--
-- == At full ================================================================================
-- Only new attachment uploads stop (upload:storage_full), with the owner told once. Records,
-- downloads, forms without attachments and text chat carry on; nothing is ever deleted to make
-- room (decision 15). Owners are warned at 80% and 95% (engineering defaults, not founder terms).
--
-- == Automatic blocks (decision 34) ==========================================================
-- Off by default. An owner may switch it on with a monthly rand ceiling for storage blocks that
-- counts the blocks already held: R98 allows at most two R49 blocks in total, never two more each
-- month. Under the pool's lock and the subscription's lock the missing block is added at once
-- and its pro-rata amount for the rest of the storage month becomes a storage charge on the next
-- invoice, so two uploads at the same moment cannot buy two blocks. Never in the grace (no paid
-- extras), never for an exempt or unsubscribed business. Buying by hand goes through A2's quotes
-- (migration 20261118120100).
--
-- == Safe on live data =======================================================================
-- New columns with defaults that change nobody's price (no blocks, automatic off), new tables and
-- replaced functions with the same signatures. Pipeline uploads were unlimited until now
-- (app.storage_quota_bytes answered null); from this migration they stop at the allowance.

-- == Prices and quantities ==================================================================
alter table public.billing_settings
  add column if not exists storage_block_monthly_incl_cents bigint not null default 4900;
alter table public.billing_settings drop constraint if exists billing_settings_storage_block_ck;
alter table public.billing_settings add constraint billing_settings_storage_block_ck
  check (storage_block_monthly_incl_cents >= 0);
comment on column public.billing_settings.storage_block_monthly_incl_cents is
  'Price of one 10 GB storage block for one month (decision 15: R49), charged monthly whatever the '
  'software term. Snapshotted on every storage charge (20261118120000).';

alter table public.billing_subscriptions add column if not exists storage_blocks integer not null default 0;
alter table public.billing_subscriptions add column if not exists pending_storage_blocks integer;
alter table public.billing_subscriptions add column if not exists pending_storage_blocks_on date;
alter table public.billing_subscriptions drop constraint if exists billing_subscriptions_storage_blocks_ck;
alter table public.billing_subscriptions add constraint billing_subscriptions_storage_blocks_ck check (
  storage_blocks between 0 and 1000
  and (pending_storage_blocks is null or pending_storage_blocks between 0 and 1000)
  and ((pending_storage_blocks is null) = (pending_storage_blocks_on is null)));
comment on column public.billing_subscriptions.storage_blocks is
  'Paid 10 GB storage blocks in force (20261118120000). Raised by a paid change quote or an '
  'automatic purchase; lowered only at the start of a storage month, from pending_storage_blocks.';

-- Pure arithmetic, decimal bytes (BRIEF section 11). Mirrored by src/lib/storage-allowance.ts.
create or replace function app.storage_included_bytes(p_full integer, p_equipment integer) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select greatest(2000000000::bigint,
                  greatest(coalesce(p_full, 0), 0)::bigint * 100000000
                + greatest(coalesce(p_equipment, 0), 0)::bigint * 25000000);
$$;
revoke all on function app.storage_included_bytes(integer, integer) from public, anon;
grant execute on function app.storage_included_bytes(integer, integer) to authenticated, service_role;

create or replace function app.storage_block_bytes() returns bigint
language sql immutable set search_path = public, pg_temp as $$ select 10000000000::bigint $$;
revoke all on function app.storage_block_bytes() from public, anon;
grant execute on function app.storage_block_bytes() to authenticated, service_role;

-- Buckets whose objects never count against a customer's pool.
create or replace function app.storage_uncounted_buckets() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['billing-proofs', 'partner-docs', 'partner-receipts', 'partner-branding', 'menu-media', 'command-audio'];
$$;
revoke all on function app.storage_uncounted_buckets() from public, anon, authenticated, service_role;

-- == The pool ===============================================================================
-- Replaces 20261115090000's "just itself": the customer's billing site and its other sites.
create or replace function app.storage_pool_farm_ids(p_farm uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select array_agg(f.id order by f.id)
       from public.farms f
      where f.id = app.billing_root(p_farm)
         or (f.billed_through = app.billing_root(p_farm) and f.deleted_at is null)),
    array[p_farm]);
$$;
revoke all on function app.storage_pool_farm_ids(uuid) from public, anon, authenticated, service_role;
comment on function app.storage_pool_farm_ids(uuid) is
  'The sites sharing one storage allowance: the billing site and every site billed through it '
  '(decision 22, 20261118120000).';

-- The storage month a date falls in: the billing period for a monthly subscription; for an annual
-- one, months stepped from the period start on the anchor day (storage is charged monthly
-- whatever the software term, BRIEF section 11). Without a period yet: this month from today.
create or replace function app.storage_month(p_sub uuid, p_today date)
returns table (month_start date, month_end date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s public.billing_subscriptions%rowtype;
  v_start date;
  v_next date;
  v_guard integer := 0;
begin
  select * into s from public.billing_subscriptions where id = p_sub;
  if not found or s.current_period_start is null or s.current_period_end is null
     or p_today < s.current_period_start or p_today > s.current_period_end then
    month_start := p_today;
    month_end := app.billing_advance_period(p_today, 'monthly', extract(day from p_today)::integer) - 1;
    return next;
    return;
  end if;
  if s.billing_period = 'monthly' then
    month_start := s.current_period_start;
    month_end := s.current_period_end;
    return next;
    return;
  end if;
  v_start := s.current_period_start;
  loop
    v_next := app.billing_advance_period(v_start, 'monthly',
                coalesce(s.anchor_day, extract(day from s.current_period_start)::integer));
    exit when v_next > p_today or v_guard > 24;
    v_start := v_next;
    v_guard := v_guard + 1;
  end loop;
  month_start := v_start;
  month_end := least(v_next - 1, s.current_period_end);
  return next;
end $$;
revoke all on function app.storage_month(uuid, date) from public, anon, authenticated, service_role;

-- The allowance in force and at the next renewal, for the pool a site belongs to.
create or replace function app.storage_allowance(p_farm uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_root      uuid := app.billing_root(p_farm);
  v_sub       public.billing_subscriptions%rowtype;
  v_price     public.billing_price_versions%rowtype;
  v_next      public.billing_price_versions%rowtype;
  v_full_in   integer := app.billable_asset_count(app.billing_root(p_farm));
  v_eq_in     integer := app.billable_equipment_count(app.billing_root(p_farm));
  v_inc       integer := 0;
  v_inc_next  integer := 0;
  v_full      integer;
  v_eq        integer;
  v_full_next integer;
  v_eq_next   integer;
  v_blocks    integer := 0;
  v_blocks_nx integer := 0;
  v_included  bigint;
  v_incl_next bigint;
  v_override  bigint;
  v_block_price bigint;
begin
  select * into v_sub from public.billing_subscriptions where id = app.billing_subscription_for(v_root);
  if found then
    select * into v_price from app.billing_price_for_subscription(v_sub.id);
    if v_sub.pending_plan is not null then
      select * into v_next from app.billing_active_price(v_sub.pending_plan, coalesce(v_sub.pending_billing_period, v_sub.billing_period));
    end if;
    if v_next.id is null then
      v_next := v_price;
    end if;
  end if;
  if v_price.id is not null and v_price.equipment_period_incl_cents is not null then
    v_inc := coalesce(v_price.equipment_included, 0);
  end if;
  if v_next.id is not null and v_next.equipment_period_incl_cents is not null then
    v_inc_next := coalesce(v_next.equipment_included, 0);
  end if;

  if v_sub.id is null then
    -- No subscription (made by Rapid Rise, never signed up): what is in use, at least the minimum.
    v_full := v_full_in;
    v_eq := v_eq_in;
    v_full_next := v_full_in;
    v_eq_next := v_eq_in;
  else
    v_full := greatest(coalesce(v_sub.asset_quota, v_full_in), coalesce(v_price.min_billed_slots, 0));
    v_eq := case when v_sub.asset_quota is null then greatest(v_inc, v_eq_in)
                 else v_inc + coalesce(v_sub.equipment_extra_quota, 0) end;
    v_full_next := greatest(coalesce(v_sub.pending_quota, v_sub.asset_quota, v_full_in),
                            coalesce(v_next.min_billed_slots, v_price.min_billed_slots, 0));
    -- At a renewal the extra equipment is what is then in use beyond the allowance.
    v_eq_next := greatest(v_inc_next, v_eq_in);
    v_blocks := coalesce(v_sub.storage_blocks, 0);
    v_blocks_nx := coalesce(v_sub.pending_storage_blocks, v_blocks);
  end if;

  v_included := app.storage_included_bytes(v_full, v_eq);
  v_incl_next := app.storage_included_bytes(v_full_next, v_eq_next);
  select o.quota_bytes into v_override from app.storage_quota_overrides o where o.farm_id = v_root;
  if v_override is null then
    select o.quota_bytes into v_override from app.storage_quota_overrides o where o.farm_id = p_farm;
  end if;
  select storage_block_monthly_incl_cents into v_block_price from public.billing_settings where singleton limit 1;

  return jsonb_build_object(
    'root', v_root,
    'subscription_id', v_sub.id,
    'billing_period', v_sub.billing_period,
    'full_spaces', v_full,
    'equipment_spaces', v_eq,
    'included_bytes', v_included,
    'blocks', v_blocks,
    'block_bytes', app.storage_block_bytes(),
    'block_monthly_cents', coalesce(v_block_price, 4900),
    'override_bytes', v_override,
    'total_bytes', coalesce(v_override, v_included + v_blocks::bigint * app.storage_block_bytes()),
    'next', jsonb_build_object(
      'full_spaces', v_full_next,
      'equipment_spaces', v_eq_next,
      'included_bytes', v_incl_next,
      'blocks', v_blocks_nx,
      'blocks_on', v_sub.pending_storage_blocks_on,
      'total_bytes', coalesce(v_override, v_incl_next + v_blocks_nx::bigint * app.storage_block_bytes())));
end $$;
revoke all on function app.storage_allowance(uuid) from public, anon, authenticated, service_role;
comment on function app.storage_allowance(uuid) is
  'The pool''s attachment allowance now and at the next renewal: max(2 GB, full x 100 MB + '
  'equipment x 25 MB) plus 10 GB per paid block, decimal bytes (decision 14, 20261118120000).';

-- Replaces 20261115090000's override-only hook. Never null any more: every pool has an allowance.
create or replace function app.storage_quota_bytes(p_farm uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select (app.storage_allowance(p_farm) ->> 'total_bytes')::bigint;
$$;
revoke all on function app.storage_quota_bytes(uuid) from public, anon, authenticated, service_role;
comment on function app.storage_quota_bytes(uuid) is
  'The pool''s attachment allowance in bytes (app.storage_allowance total), 20261118120000.';

-- == Measuring what is stored ===============================================================
create table if not exists public.storage_usage_snapshots (
  farm_id          uuid not null references public.farms(id),
  measured_on      date not null,
  -- The pool it belonged to that day (its billing site), so a past period is read as it was.
  root_farm_id     uuid not null references public.farms(id),
  tracked_bytes    bigint not null default 0 check (tracked_bytes >= 0),
  untracked_bytes  bigint not null default 0 check (untracked_bytes >= 0),
  untracked_objects integer not null default 0 check (untracked_objects >= 0),
  reserved_bytes   bigint not null default 0 check (reserved_bytes >= 0),
  -- On the billing site's row only (null on the others): the pool's allowance that day.
  allowance_bytes  bigint check (allowance_bytes is null or allowance_bytes >= 0),
  included_bytes   bigint check (included_bytes is null or included_bytes >= 0),
  blocks           integer check (blocks is null or blocks >= 0),
  by_bucket        jsonb not null default '{}'::jsonb,
  measured_at      timestamptz not null default now(),
  primary key (farm_id, measured_on)
);
create index if not exists storage_usage_snapshots_root_idx on public.storage_usage_snapshots (root_farm_id, measured_on);
comment on table public.storage_usage_snapshots is
  'What each site stored on each South African day: pipeline files, objects without an upload '
  'intent (files from before the pipeline, older paths, orphans) and reservations; the billing '
  'site''s row carries the pool allowance. The record of storage per billing period '
  '(20261118120000). Written by the nightly measure only.';
alter table public.storage_usage_snapshots enable row level security;
alter table public.storage_usage_snapshots force row level security;
revoke all on public.storage_usage_snapshots from public, anon, authenticated;
grant select on public.storage_usage_snapshots to authenticated;
grant all on public.storage_usage_snapshots to service_role;
drop policy if exists storage_usage_snapshots_sel on public.storage_usage_snapshots;
create policy storage_usage_snapshots_sel on public.storage_usage_snapshots for select to authenticated
  using ((select app.is_farm_billing_admin(farm_id)));
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('storage_usage_snapshots', 'open', 'paying: what the account stores, read by the owner while it is stopped')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('storage_usage_snapshots');

-- Objects in the sites' folders that no upload intent describes, with bytes per bucket.
create or replace function app.storage_untracked(p_farms uuid[])
returns table (farm_id uuid, bytes bigint, objects integer, by_bucket jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if to_regclass('storage.objects') is null or p_farms is null then
    return;
  end if;
  return query execute
    $q$ with o as (
          select split_part(x.name, '/', 1) as site, x.bucket_id::text as bucket,
                 coalesce((x.metadata ->> 'size')::bigint, 0) as size
            from storage.objects x
           where split_part(x.name, '/', 1) = any ($1)
             and not (x.bucket_id::text = any (app.storage_uncounted_buckets()))
             and not exists (select 1 from public.upload_intents i
                              where i.object_path = x.name and i.bucket = x.bucket_id::text)
        ), b as (
          select site, bucket, sum(size)::bigint as bytes, count(*)::integer as n from o group by site, bucket
        )
        select site::uuid, sum(bytes)::bigint, sum(n)::integer, jsonb_object_agg(bucket, bytes)
          from b group by site $q$
    using (select array_agg(f::text) from unnest(p_farms) f);
end $$;
revoke all on function app.storage_untracked(uuid[]) from public, anon, authenticated, service_role;

-- Bytes the pool holds (finalised pipeline files not yet removed), bytes reserved by uploads in
-- flight (optionally leaving one intent out: its own growth is being judged), and the latest
-- measured bytes with no intent. Replaces 20261115090000's version, which counted the first two.
create or replace function app.storage_pool_usage(p_farms uuid[], p_except uuid default null)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select (select coalesce(sum(case
                 when i.status = 'finalised' then coalesce(i.actual_bytes, i.reserved_bytes)
                 else i.reserved_bytes end), 0)
            from public.upload_intents i
           where i.farm_id = any (p_farms)
             and i.counts_against_quota
             and (p_except is null or i.id <> p_except)
             and ((i.status = 'finalised' and i.object_removed_at is null)
                  or (i.status in ('reserved', 'uploaded') and i.expires_at > now())))::bigint
       + (select coalesce(sum(x.untracked_bytes), 0)
            from unnest(p_farms) f(id)
            cross join lateral (
              select s.untracked_bytes from public.storage_usage_snapshots s
               where s.farm_id = f.id order by s.measured_on desc limit 1) x)::bigint;
$$;
revoke all on function app.storage_pool_usage(uuid[], uuid) from public, anon, authenticated, service_role;

-- == Owner settings, warnings and automatic blocks ===========================================
create table if not exists public.storage_pool_settings (
  -- The billing site: one row per customer pool.
  farm_id              uuid primary key references public.farms(id),
  auto_blocks          boolean not null default false,
  -- The most the storage blocks may come to in a month, existing ones included (decision 34).
  auto_ceiling_cents   bigint check (auto_ceiling_cents is null or auto_ceiling_cents >= 0),
  auto_accepted_by     uuid references public.users(id) on delete set null,
  auto_accepted_at     timestamptz,
  auto_terms_version   text check (auto_terms_version is null or length(auto_terms_version) <= 40),
  -- The allowance a warning was last sent for, so a larger allowance warns again.
  warned_80_bytes      bigint,
  warned_95_bytes      bigint,
  warned_full_bytes    bigint,
  updated_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  constraint storage_pool_settings_auto_ck check (
    not auto_blocks or (auto_ceiling_cents is not null and auto_accepted_at is not null))
);
comment on table public.storage_pool_settings is
  'Per customer pool: automatic 10 GB blocks (off by default) with the owner''s monthly ceiling '
  'and acceptance, and which warnings were sent (20261118120000).';
alter table public.storage_pool_settings enable row level security;
alter table public.storage_pool_settings force row level security;
revoke all on public.storage_pool_settings from public, anon, authenticated;
grant select on public.storage_pool_settings to authenticated;
grant all on public.storage_pool_settings to service_role;
drop policy if exists storage_pool_settings_sel on public.storage_pool_settings;
create policy storage_pool_settings_sel on public.storage_pool_settings for select to authenticated
  using ((select app.is_farm_billing_admin(farm_id)));
drop trigger if exists storage_pool_settings_audit on public.storage_pool_settings;
create trigger storage_pool_settings_audit after insert or update or delete on public.storage_pool_settings
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('storage_pool_settings', 'rapid_rise', 'billing: automatic storage purchases are the owner''s')
on conflict (table_name) do nothing;
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('storage_pool_settings', 'open', 'paying: the owner reads the storage purchase setting while stopped')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('storage_pool_settings');

-- Storage charges not carried by a change invoice: the monthly block charge and the pro-rata
-- amount of an automatic block. Stamped onto exactly one invoice, once (20261118120100).
create table if not exists public.storage_charges (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null references public.farms(id),
  subscription_id    uuid not null references public.billing_subscriptions(id),
  kind               text not null check (kind in ('monthly', 'auto_block')),
  blocks             integer not null check (blocks > 0),
  unit_incl_cents    bigint not null check (unit_incl_cents >= 0),
  period_start       date not null,
  period_end         date not null,
  days_charged       integer not null check (days_charged > 0),
  days_in_period     integer not null check (days_in_period > 0),
  amount_incl_cents  bigint not null check (amount_incl_cents >= 0),
  invoice_id         uuid references public.billing_invoices(id),
  note               text check (note is null or length(note) <= 300),
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint storage_charges_period_ck check (period_end >= period_start and days_charged <= days_in_period)
);
-- One monthly block charge per subscription and storage month: a retried run cannot bill twice.
create unique index if not exists storage_charges_monthly_uq
  on public.storage_charges (subscription_id, period_start) where kind = 'monthly';
create index if not exists storage_charges_open_idx
  on public.storage_charges (farm_id) where invoice_id is null;
comment on table public.storage_charges is
  'Storage block charges outside a change invoice: one monthly charge per subscription and storage '
  'month, and the pro-rata part of an automatic block. Each is stamped onto one invoice once '
  '(20261118120000).';
alter table public.storage_charges enable row level security;
alter table public.storage_charges force row level security;
revoke all on public.storage_charges from public, anon, authenticated;
grant select on public.storage_charges to authenticated;
grant all on public.storage_charges to service_role;
drop policy if exists storage_charges_sel on public.storage_charges;
create policy storage_charges_sel on public.storage_charges for select to authenticated
  using ((select app.is_farm_billing_admin(farm_id)));
drop trigger if exists storage_charges_audit on public.storage_charges;
create trigger storage_charges_audit after insert or update or delete on public.storage_charges
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('storage_charges', 'rapid_rise', 'billing: the owner only')
on conflict (table_name) do nothing;
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('storage_charges', 'open', 'paying: storage charges the account owes')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('storage_charges');

-- A money record: never deleted, and never changed except to stamp the invoice once.
create or replace function app.storage_charges_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'storage_charges is a money record and is never deleted.' using errcode = '42501';
  end if;
  if old.invoice_id is null and new.invoice_id is not null
     and (to_jsonb(new) - 'invoice_id') = (to_jsonb(old) - 'invoice_id') then
    return new;
  end if;
  raise exception 'storage_charges rows cannot be changed once written.' using errcode = '42501';
end $$;
revoke all on function app.storage_charges_guard() from public, anon, authenticated;
drop trigger if exists storage_charges_guard on public.storage_charges;
create trigger storage_charges_guard before update or delete on public.storage_charges
  for each row execute function app.storage_charges_guard();

-- Owners told once per allowance at 80%, 95% and when an upload is refused for being full (that
-- one from public.storage_note_full, after the refusal rolled back). Called with the pool's lock.
create or replace function app.storage_pool_warn(p_root uuid, p_used bigint, p_total bigint, p_full boolean)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.storage_pool_settings%rowtype;
  v_level text;
begin
  if p_total is null or p_total <= 0 then
    return null;
  end if;
  insert into public.storage_pool_settings (farm_id) values (p_root) on conflict (farm_id) do nothing;
  select * into s from public.storage_pool_settings where farm_id = p_root for update;
  if p_full then
    if s.warned_full_bytes is distinct from p_total then
      update public.storage_pool_settings set warned_full_bytes = p_total where farm_id = p_root;
      perform app.billing_notify_owners(p_root, 'storage_full',
        jsonb_build_object('used_bytes', p_used, 'total_bytes', p_total));
      return 'full';
    end if;
    return null;
  end if;
  if p_used * 100 >= p_total * 95 then
    v_level := '95';
    if s.warned_95_bytes is distinct from p_total then
      update public.storage_pool_settings set warned_95_bytes = p_total, warned_80_bytes = p_total where farm_id = p_root;
      perform app.billing_notify_owners(p_root, 'storage_warning',
        jsonb_build_object('percent', 95, 'used_bytes', p_used, 'total_bytes', p_total));
      return v_level;
    end if;
  elsif p_used * 100 >= p_total * 80 then
    v_level := '80';
    if s.warned_80_bytes is distinct from p_total then
      update public.storage_pool_settings set warned_80_bytes = p_total where farm_id = p_root;
      perform app.billing_notify_owners(p_root, 'storage_warning',
        jsonb_build_object('percent', 80, 'used_bytes', p_used, 'total_bytes', p_total));
      return v_level;
    end if;
  end if;
  return null;
end $$;
revoke all on function app.storage_pool_warn(uuid, bigint, bigint, boolean) from public, anon, authenticated, service_role;

-- Tries to add the blocks an upload needs, under the owner's automatic setting. Called with the
-- pool's lock held; takes the subscription's lock too, the one every billing change takes, so a
-- quote accepted at the same moment waits. Returns the blocks added (0 when not allowed).
create or replace function app.storage_auto_block(p_root uuid, p_needed_bytes bigint, p_today date)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  st      public.storage_pool_settings%rowtype;
  s       public.billing_subscriptions%rowtype;
  v_price bigint;
  v_n     integer;
  v_start date;
  v_end   date;
  v_days  integer;
  v_total integer;
  v_exempt boolean;
begin
  if p_needed_bytes is null or p_needed_bytes <= 0 then
    return 0;
  end if;
  select * into st from public.storage_pool_settings where farm_id = p_root;
  if not found or not st.auto_blocks or st.auto_ceiling_cents is null then
    return 0;
  end if;
  select coalesce(f.billing_exempt, false) into v_exempt from public.farms f where f.id = p_root;
  if v_exempt or not app.farm_paid_extras_allowed(p_root, p_today) then
    return 0;
  end if;
  select * into s from public.billing_subscriptions
   where id = app.billing_subscription_for(p_root) for update;
  if not found or s.deleted_at is not null or s.ended_on is not null
     or s.status not in ('active', 'non_renewing') then
    return 0;
  end if;
  select storage_block_monthly_incl_cents into v_price from public.billing_settings where singleton limit 1;
  v_price := coalesce(v_price, 4900);
  v_n := ceil(p_needed_bytes::numeric / app.storage_block_bytes())::integer;
  -- Existing blocks count toward the ceiling (decision 34): R98 allows two blocks in total.
  if (s.storage_blocks + v_n)::bigint * v_price > st.auto_ceiling_cents then
    return 0;
  end if;

  select m.month_start, m.month_end into v_start, v_end from app.storage_month(s.id, p_today) m;
  v_total := (v_end - v_start) + 1;
  v_days := greatest(least((v_end - p_today) + 1, v_total), 1);
  update public.billing_subscriptions
     set storage_blocks = storage_blocks + v_n,
         -- More blocks than a reduction asked for: the reduction is overtaken.
         pending_storage_blocks = case when pending_storage_blocks is not null
                                       then greatest(pending_storage_blocks, storage_blocks + v_n) end,
         updated_at = now()
   where id = s.id;
  insert into public.storage_charges (farm_id, subscription_id, kind, blocks, unit_incl_cents,
                                      period_start, period_end, days_charged, days_in_period,
                                      amount_incl_cents, note)
  values (p_root, s.id, 'auto_block', v_n, v_price, p_today, v_end, v_days, v_total,
          app.billing_prorate_cents(v_price * v_n, v_days, v_total),
          'added automatically within the owner''s monthly storage ceiling');
  perform app.billing_notify_owners(p_root, 'storage_block_added', jsonb_build_object(
    'blocks', v_n, 'total_blocks', s.storage_blocks + v_n,
    'monthly_cents', (s.storage_blocks + v_n)::bigint * v_price,
    'ceiling_cents', st.auto_ceiling_cents,
    'today_cents', app.billing_prorate_cents(v_price * v_n, v_days, v_total)));
  return v_n;
end $$;
revoke all on function app.storage_auto_block(uuid, bigint, date) from public, anon, authenticated, service_role;

-- Takes the pool's lock (held to the end of the transaction, so two uploads cannot both see the
-- last free bytes, or both buy a block) and raises upload:storage_full when p_bytes more would
-- pass the allowance and no automatic block may be added. Same signature as 20261115090000's.
create or replace function app.storage_pool_reserve(p_farm uuid, p_bytes bigint, p_except uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_root  uuid := app.billing_root(p_farm);
  v_farms uuid[] := app.storage_pool_farm_ids(p_farm);
  v_quota bigint;
  v_used  bigint;
  v_added integer;
begin
  -- One lock per pool, whichever of its sites the upload is for.
  perform pg_advisory_xact_lock(hashtext('fleetwise:storage-pool:' || v_root::text));
  v_quota := app.storage_quota_bytes(p_farm);
  v_used := app.storage_pool_usage(v_farms, p_except);
  if v_used + p_bytes > v_quota then
    v_added := app.storage_auto_block(v_root, v_used + p_bytes - v_quota, app.billing_today());
    if v_added > 0 then
      v_quota := app.storage_quota_bytes(p_farm);
    end if;
  end if;
  if v_used + p_bytes > v_quota then
    -- The refusal rolls this transaction back, so the owner is told by public.storage_note_full,
    -- which the upload route calls after it.
    raise exception 'upload:storage_full' using errcode = 'P0001',
      detail = 'This business''s attachment storage is full.',
      hint = 'Existing files, records and text keep working. The owner can add storage on /billing.';
  end if;
  perform app.storage_pool_warn(v_root, v_used + p_bytes, v_quota, false);
end $$;
revoke all on function app.storage_pool_reserve(uuid, bigint, uuid) from public, anon, authenticated, service_role;

-- == The nightly measure ====================================================================
-- One pool: what each site holds, recorded for today (South African date), and a warning if the
-- untracked files moved the pool past a threshold.
create or replace function app.storage_measure(p_root uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farms  uuid[] := app.storage_pool_farm_ids(p_root);
  v_root   uuid := app.billing_root(p_root);
  v_today  date := app.billing_today();
  v_allow  jsonb := app.storage_allowance(p_root);
  f        uuid;
  u        record;
  v_used   bigint;
begin
  perform pg_advisory_xact_lock(hashtext('fleetwise:storage-pool:' || v_root::text));
  foreach f in array v_farms loop
    select * into u from app.storage_untracked(array[f]) x limit 1;
    insert into public.storage_usage_snapshots (
      farm_id, measured_on, root_farm_id, tracked_bytes, untracked_bytes, untracked_objects,
      reserved_bytes, allowance_bytes, included_bytes, blocks, by_bucket, measured_at)
    values (
      f, v_today, v_root,
      (select coalesce(sum(coalesce(i.actual_bytes, i.reserved_bytes)), 0) from public.upload_intents i
        where i.farm_id = f and i.counts_against_quota and i.status = 'finalised' and i.object_removed_at is null),
      coalesce(u.bytes, 0), coalesce(u.objects, 0),
      (select coalesce(sum(i.reserved_bytes), 0) from public.upload_intents i
        where i.farm_id = f and i.counts_against_quota and i.status in ('reserved', 'uploaded') and i.expires_at > now()),
      case when f = v_root then (v_allow ->> 'total_bytes')::bigint end,
      case when f = v_root then (v_allow ->> 'included_bytes')::bigint end,
      case when f = v_root then (v_allow ->> 'blocks')::integer end,
      coalesce(u.by_bucket, '{}'::jsonb), now())
    on conflict (farm_id, measured_on) do update
      set root_farm_id = excluded.root_farm_id, tracked_bytes = excluded.tracked_bytes,
          untracked_bytes = excluded.untracked_bytes, untracked_objects = excluded.untracked_objects,
          reserved_bytes = excluded.reserved_bytes, allowance_bytes = excluded.allowance_bytes,
          included_bytes = excluded.included_bytes, blocks = excluded.blocks,
          by_bucket = excluded.by_bucket, measured_at = excluded.measured_at;
  end loop;
  v_used := app.storage_pool_usage(v_farms, null);
  perform app.storage_pool_warn(v_root, v_used, (v_allow ->> 'total_bytes')::bigint, false);
  return jsonb_build_object('root', v_root, 'used_bytes', v_used, 'total_bytes', (v_allow ->> 'total_bytes')::bigint);
end $$;
revoke all on function app.storage_measure(uuid) from public, anon, authenticated, service_role;

-- Every pool, the ones measured longest ago first. Run nightly by the cron route.
create or replace function public.cron_storage_measure(p_limit integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select f.id
      from public.farms f
     where f.deleted_at is null and f.billed_through is null
     order by (select max(s.measured_on) from public.storage_usage_snapshots s where s.farm_id = f.id) nulls first, f.id
     limit greatest(coalesce(p_limit, 500), 1)
  loop
    perform app.storage_measure(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.cron_storage_measure(integer) from public, anon, authenticated;
grant execute on function public.cron_storage_measure(integer) to service_role;

-- == What a person may read and the owner may set ==========================================
-- Anyone with access to the site reads how full the pool is (so a person about to attach a
-- photo knows); money (block price, today's charge, the ceiling) only for the payer.
create or replace function public.storage_pool_status(p_farm uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_allow jsonb;
  v_root  uuid;
  v_used  bigint;
  v_total bigint;
  v_payer boolean;
  st      public.storage_pool_settings%rowtype;
  v_level text;
  v_measured date;
begin
  if auth.uid() is null or not app.has_farm_access(p_farm) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_allow := app.storage_allowance(p_farm);
  v_root := (v_allow ->> 'root')::uuid;
  v_used := app.storage_pool_usage(app.storage_pool_farm_ids(p_farm), null);
  v_total := (v_allow ->> 'total_bytes')::bigint;
  v_payer := app.is_farm_billing_admin(v_root) or app.is_farm_billing_admin(p_farm);
  select * into st from public.storage_pool_settings where farm_id = v_root;
  select max(s.measured_on) into v_measured from public.storage_usage_snapshots s where s.root_farm_id = v_root;
  v_level := case when v_used >= v_total then 'full'
                  when v_used * 100 >= v_total * 95 then '95'
                  when v_used * 100 >= v_total * 80 then '80'
                  else 'ok' end;
  return jsonb_build_object(
    'used_bytes', v_used,
    'total_bytes', v_total,
    'included_bytes', (v_allow ->> 'included_bytes')::bigint,
    'blocks', (v_allow ->> 'blocks')::integer,
    'block_bytes', app.storage_block_bytes(),
    'full_spaces', (v_allow ->> 'full_spaces')::integer,
    'equipment_spaces', (v_allow ->> 'equipment_spaces')::integer,
    'level', v_level,
    'measured_on', v_measured,
    'next', v_allow -> 'next',
    'payer', v_payer,
    'money', case when v_payer then jsonb_build_object(
      'block_monthly_cents', (v_allow ->> 'block_monthly_cents')::bigint,
      'monthly_cents', (v_allow ->> 'blocks')::bigint * (v_allow ->> 'block_monthly_cents')::bigint,
      'next_monthly_cents', (v_allow #>> '{next,blocks}')::bigint * (v_allow ->> 'block_monthly_cents')::bigint,
      'billing_period', v_allow ->> 'billing_period',
      'auto_blocks', coalesce(st.auto_blocks, false),
      'auto_ceiling_cents', st.auto_ceiling_cents,
      'auto_accepted_at', st.auto_accepted_at) end);
end $$;
revoke all on function public.storage_pool_status(uuid) from public, anon;
grant execute on function public.storage_pool_status(uuid) to authenticated, service_role;
comment on function public.storage_pool_status(uuid) is
  'How full the customer''s storage pool is, for anyone with access to the site; prices, blocks '
  'and the automatic setting for the payer only (20261118120000).';

-- The owner switches automatic blocks on (with a ceiling, accepting the charge method) or off.
-- A ceiling below the cost of the blocks already held is refused: it could never allow one.
create or replace function public.storage_set_auto(
  p_farm uuid, p_enabled boolean, p_ceiling_cents bigint, p_terms_version text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_root  uuid := app.billing_root(p_farm);
  v_allow jsonb;
  v_held  bigint;
begin
  if v_uid is null or not app.has_farm_access(p_farm) or not app.is_farm_billing_admin(v_root) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(v_root, true);
  if coalesce(p_enabled, false) then
    if p_ceiling_cents is null or p_ceiling_cents < 0 or p_ceiling_cents > 100000000 then
      raise exception 'storage-ceiling-invalid' using errcode = '22023';
    end if;
    if p_terms_version is null or p_terms_version !~ '^[a-z0-9.-]{1,40}$' then
      raise exception 'storage-terms-required' using errcode = '22023';
    end if;
    v_allow := app.storage_allowance(v_root);
    v_held := (v_allow ->> 'blocks')::bigint * (v_allow ->> 'block_monthly_cents')::bigint;
    if p_ceiling_cents < v_held + (v_allow ->> 'block_monthly_cents')::bigint then
      raise exception 'storage-ceiling-too-low' using errcode = '22023',
        hint = 'The ceiling counts the blocks already held; it must leave room for at least one more.';
    end if;
  end if;
  insert into public.storage_pool_settings (farm_id) values (v_root) on conflict (farm_id) do nothing;
  update public.storage_pool_settings
     set auto_blocks = coalesce(p_enabled, false),
         auto_ceiling_cents = case when coalesce(p_enabled, false) then p_ceiling_cents else auto_ceiling_cents end,
         auto_accepted_by = case when coalesce(p_enabled, false) then v_uid else auto_accepted_by end,
         auto_accepted_at = case when coalesce(p_enabled, false) then now() else auto_accepted_at end,
         auto_terms_version = case when coalesce(p_enabled, false) then p_terms_version else auto_terms_version end,
         updated_by = v_uid, updated_at = now()
   where farm_id = v_root;
  return jsonb_build_object('auto_blocks', coalesce(p_enabled, false), 'ceiling_cents', p_ceiling_cents);
end $$;
revoke all on function public.storage_set_auto(uuid, boolean, bigint, text) from public, anon;
grant execute on function public.storage_set_auto(uuid, boolean, bigint, text) to authenticated;
comment on function public.storage_set_auto(uuid, boolean, bigint, text) is
  'The owner switches automatic 10 GB blocks on, with a monthly ceiling that counts the blocks '
  'held and the accepted terms version, or off (decision 34, 20261118120000).';

-- After an upload was refused for a full pool (the refusal rolled its own transaction back): the
-- owner is told, once per allowance. Only when the pool really is at least 95% full, so a member
-- cannot use it to send owners a false alarm.
create or replace function public.storage_note_full(p_farm uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_root  uuid := app.billing_root(p_farm);
  v_used  bigint;
  v_total bigint;
begin
  if auth.uid() is null or not app.has_farm_access(p_farm) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  perform pg_advisory_xact_lock(hashtext('fleetwise:storage-pool:' || v_root::text));
  v_used := app.storage_pool_usage(app.storage_pool_farm_ids(p_farm), null);
  v_total := app.storage_quota_bytes(p_farm);
  if v_used * 100 < v_total * 95 then
    return false;
  end if;
  return app.storage_pool_warn(v_root, v_used, v_total, true) is not null;
end $$;
revoke all on function public.storage_note_full(uuid) from public, anon;
grant execute on function public.storage_note_full(uuid) to authenticated;
comment on function public.storage_note_full(uuid) is
  'Tells the owners, once per allowance, that an upload was refused because the pool is full '
  '(only when it is at least 95% full), 20261118120000.';
