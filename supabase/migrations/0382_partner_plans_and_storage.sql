-- 0382_partner_plans_and_storage.sql
-- F14e — Partner plans reshaped around what a partner actually buys, plus the Storage
-- buckets the branding and document work needs.
--
-- WHY THE PLAN NAMES CHANGE. `free`/`pro` (0320) named a position on a ladder, not a
-- product. Partners are choosing between two genuinely different products:
--
--   portal   — "my customers can see their fleet with me in it." Work requests, the
--              vehicle history their farms already keep, their own letterhead, and the
--              ability to attach the quotes and invoices they produce in Sage, Xero, a
--              spreadsheet or a receipt book. Their existing system stays their system.
--   managed  — everything in portal, plus running the commercial side here: building
--              quotes and invoices line by line, converting a quote to an invoice,
--              recording payments and proofs, and cross-client analytics.
--
-- The distinction is deliberate: a partner is NEVER dependent on our invoicing to be
-- useful to their farmers. Uploading a document you produced elsewhere is core, on every
-- plan. Only BUILDING documents here is the paid step up — which is also why the price
-- differs, and why nothing in `portal` degrades if they never upgrade.
--
-- Data map: free → portal, pro → managed. Every existing partner keeps at least what
-- they had (pro had cross-client analytics; managed has it too).
--
-- PAYMENTS REMAIN DEFERRED. This column moves no money; it is the single stored input
-- `src/lib/contractor-plan.ts` reads. As in 0320 it is NOT a tenancy guard — RLS +
-- workshop_links stay the sole isolation guarantor — so it needs no SQL mirror.

-- ── portal / managed ──────────────────────────────────────────────
-- A brand-new enum (not ALTER TYPE ADD VALUE) so the whole file stays transaction-safe,
-- exactly as 0250 did for farm plans.
create type workshop_plan_v2 as enum ('portal', 'managed');

alter table workshops add column plan_v2 workshop_plan_v2 not null default 'portal';

update workshops set plan_v2 = case plan when 'pro' then 'managed' else 'portal' end::workshop_plan_v2;

-- The guard trigger from 0380 protects `plan`; point it at the new column before the
-- swap so there is no window in which a partner could set its own tier.
create or replace function app_workshop_guard_plan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.plan_v2 is distinct from old.plan_v2 and not app.is_rr_admin() then
    raise exception 'the partner plan is set by Rapid Rise, not by the partner';
  end if;
  return new;
end $$;

alter table workshops drop column plan;
drop type workshop_plan;
alter type workshop_plan_v2 rename to workshop_plan;
alter table workshops rename column plan_v2 to plan;

-- Renaming the column after the function was written means the guard now reads a column
-- that no longer exists under that name; restate it against the final shape.
create or replace function app_workshop_guard_plan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.plan is distinct from old.plan and not app.is_rr_admin() then
    raise exception 'the partner plan is set by Rapid Rise, not by the partner';
  end if;
  return new;
end $$;

comment on column workshops.plan is
  'Partner product: portal = customer portal + their own uploaded paperwork; '
  'managed = build quotes/invoices, record payments, cross-client analytics. '
  'App-gated via src/lib/contractor-plan.ts — NOT a tenancy guard. Payments deferred.';

-- ── Storage ───────────────────────────────────────────────────────
-- Two buckets, because the two things are scoped differently:
--
--   partner-branding  keyed `{workshop_id}/…` — a partner's logo. Readable by any
--                     signed-in user, because a farmer looking at a quote must see the
--                     letterhead of the partner who sent it; writable only by that
--                     partner's own staff (or RR).
--   partner-docs      keyed `{farm_id}/{document_id}/…` — uploaded quotes/invoices and
--                     proofs of payment. Farm-scoped exactly like every other document
--                     bucket, so it joins the existing policy set.
--
-- Guarded so this is a no-op on a local test Postgres with no `storage` schema.
do $do$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;
  end if;

  insert into storage.buckets (id, name, public) values
    ('partner-docs', 'partner-docs', false),
    ('partner-branding', 'partner-branding', false)
  on conflict (id) do nothing;

  -- Farm-scoped set, with partner-docs added.
  execute 'drop policy if exists "farmgear objects read"   on storage.objects';
  execute 'drop policy if exists "farmgear objects insert" on storage.objects';
  execute 'drop policy if exists "farmgear objects update" on storage.objects';
  execute 'drop policy if exists "farmgear objects delete" on storage.objects';

  execute $p$
    create policy "farmgear objects read" on storage.objects for select to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects insert" on storage.objects for insert to authenticated
    with check (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects update" on storage.objects for update to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects delete" on storage.objects for delete to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;

  -- Workshop-scoped set, for the letterhead.
  execute 'drop policy if exists "partner branding read"  on storage.objects';
  execute 'drop policy if exists "partner branding write" on storage.objects';
  execute 'drop policy if exists "partner branding wipe"  on storage.objects';

  execute $p$
    create policy "partner branding read" on storage.objects for select to authenticated
    using (bucket_id = 'partner-branding')
  $p$;
  execute $p$
    create policy "partner branding write" on storage.objects for insert to authenticated
    with check (bucket_id = 'partner-branding'
      and (app.is_rr_admin()
           or nullif((storage.foldername(name))[1], '')::uuid = app.user_workshop_id()))
  $p$;
  execute $p$
    create policy "partner branding wipe" on storage.objects for delete to authenticated
    using (bucket_id = 'partner-branding'
      and (app.is_rr_admin()
           or nullif((storage.foldername(name))[1], '')::uuid = app.user_workshop_id()))
  $p$;
end $do$;
