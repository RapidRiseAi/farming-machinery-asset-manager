-- 0392_contractor_cards_and_request_target.sql
-- Two corrections from review of F15, both real.
--
-- ── 1. A CONTRACTOR COULD READ ITS COMPETITORS' CARDS ────────────────────────
--
-- 0391 widened `workshops_sel` to let a farm see a contractor with a PENDING link, so a
-- connection request would stop rendering as a nameless row. The clause it widened is
-- guarded by `app.has_farm_access(wl.farm_id)` — and that helper deliberately returns
-- true for a WORKSHOP holding an active link to the farm (0340), because that is how a
-- contractor reaches the farms it serves.
--
-- The consequence: any contractor already working for a farm could read the name, trade,
-- area, phone and email of every OTHER contractor linked to that same farm — including
-- one that had merely asked. My own migration comment claimed the card was disclosed "to
-- the one farm they asked", which was simply not true as written.
--
-- Note this was not new in 0391: the pre-existing `status = 'active'` clause had the same
-- hole, so two contractors on a shared farm could already read each other. 0391 only made
-- it worse. Both are closed here.
--
-- The fix is to say what was meant: this clause is for the FARM SIDE. A workshop still
-- reads its own row through `id = app.user_workshop_id()`, and rr_admin still sees all.
create or replace function app.is_farm_side() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.active and u.deleted_at is null
      and u.role in ('owner', 'manager', 'mechanic', 'operator')
  );
$$;

revoke execute on function app.is_farm_side() from public, anon;
grant  execute on function app.is_farm_side() to authenticated, service_role;

drop policy workshops_sel on workshops;

create policy workshops_sel on workshops for select to authenticated
  using (
    app.is_rr_admin()
    or id = app.user_workshop_id()
    or (
      -- FARM-SIDE ONLY. Without this guard `has_farm_access` also admits a workshop, and
      -- a contractor would be reading its competitors' business cards.
      app.is_farm_side()
      and id in (
        select wl.workshop_id from public.workshop_links wl
        where app.has_farm_access(wl.farm_id)
          and wl.status in ('active', 'pending')
          and wl.deleted_at is null
      )
    )
  );

-- ── 2. AN APPROVAL BOUND THE WRONG CLIENT (OR NONE) ──────────────────────────
--
-- `approveLinkRequest` had no way to know WHICH client record the request came from, so
-- it updated every unbound `requested` row for that workshop and set them all to the
-- approving farm. With two outstanding requests that violates the
-- `(workshop_id, farm_id)` unique index, so the whole statement fails — after the link
-- has already gone active — and the error was swallowed, leaving the UI reporting success
-- with nothing bound. With one outstanding request it could still bind the wrong record.
--
-- Remember which farm each request was aimed at, and approval can bind exactly that row.
alter table partner_clients
  add column requested_farm_id uuid references farms(id);

comment on column partner_clients.requested_farm_id is
  'The farm a connection request was aimed at, so an approval binds exactly this client '
  'record rather than guessing among the workshop''s other outstanding requests.';

-- Backfill: any request raised before this column existed can be matched by the pending
-- link, when the workshop has exactly one.
update partner_clients pc
   set requested_farm_id = wl.farm_id
  from workshop_links wl
 where pc.link_status = 'requested'
   and pc.farm_id is null
   and pc.requested_farm_id is null
   and wl.workshop_id = pc.workshop_id
   and wl.status = 'pending'
   and wl.deleted_at is null
   and (select count(*) from partner_clients p2
         where p2.workshop_id = pc.workshop_id
           and p2.link_status = 'requested' and p2.farm_id is null) = 1;
