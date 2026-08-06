-- 0390_partner_clients.sql
-- F15 — A partner's OWN client book, and the road from it to a real FleetWise farm.
--
-- Until now a partner could only see farms that had already found them and connected
-- (F12a `workshop_links`). That is backwards for the business we are asking them to run
-- here: a mechanic's customer list exists before FleetWise does, most of it is not on
-- FleetWise at all, and a management system they cannot put their whole book into is not
-- a management system. AutoVault solved this with `workshop_prospect_customers`; this is
-- the same idea, sized for our tenancy.
--
-- ── THE TENANCY QUESTION, ANSWERED FIRST ─────────────────────────────────────
--
-- These are the first tables in the product owned by a WORKSHOP rather than a farm, so
-- be explicit about what they are and are not:
--
--   * A `partner_client` is the PARTNER'S OWN NOTE about a customer. It is their data,
--     scoped to their workshop, and it carries no authority whatsoever.
--   * Setting `farm_id` on one does NOT grant the partner access to that farm. Access
--     comes from an ACTIVE `workshop_link` and nothing else — `app.has_farm_access` is
--     unchanged by this migration and still ignores these tables entirely.
--   * So the worst a forged or mistaken `partner_client` row can do is put a wrong name
--     in the partner's own list. It cannot widen what they can read.
--
-- ── HOW A CLIENT BECOMES A LINKED FARM ───────────────────────────────────────
--
-- `workshop_link_status` already has 'pending', and `has_farm_access` only counts
-- 'active' — so a request needs no new table: it is a pending link. This migration adds
-- the one policy that lets a partner RAISE such a request (and only a pending one, and
-- only for its own workshop). Approving it stays exactly where it was: with the farm's
-- own owner/manager, through the existing update policy that a workshop is not covered
-- by. A partner therefore cannot connect itself to anybody.
--
-- The partner never learns whether the customer they asked for is on FleetWise. The
-- server action resolves the email with the service role and either raises the request
-- or hands back a sign-up link, and says the same thing either way — because "does this
-- address have an account" is not a partner's question to ask of the whole customer base.

-- ── The partner's client book ─────────────────────────────────────────────────
create type partner_client_link as enum ('unlinked', 'requested', 'linked', 'declined');

create table partner_clients (
  id            uuid primary key default gen_random_uuid(),
  workshop_id   uuid not null references workshops(id) on delete cascade,
  name          text not null,                 -- the business or farm as the partner knows it
  contact_name  text,
  phone         text,
  whatsapp      text,
  email         text,
  address       text,
  notes         text,
  -- Set only once an actual link exists. Informational: it does NOT grant access.
  farm_id       uuid references farms(id),
  link_status   partner_client_link not null default 'unlinked',
  requested_at  timestamptz,
  linked_at     timestamptz,
  -- True once the partner has copied this client's vehicles into the linked farm, so the
  -- offer to do it stops being made and nobody duplicates a fleet by pressing twice.
  synced_at     timestamptz,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid,
  -- One record per farm per partner, so a link cannot be represented twice.
  constraint partner_clients_farm_uq unique (workshop_id, farm_id)
);
create index partner_clients_workshop_idx on partner_clients(workshop_id, link_status);
create index partner_clients_farm_idx     on partner_clients(farm_id);

-- ── Vehicles the partner tracks before there is a farm to hold them ──────────
-- Free text on purpose. These are not `machines`: a machine belongs to a farm, is
-- governed by farm RLS and carries the whole service/cost model. This is a mechanic's
-- notebook — "Danie's blue Hilux, ADT 441 FS" — and its only job is to be useful before
-- the customer is on FleetWise, and to be copyable into the real fleet afterwards.
create table partner_client_vehicles (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid not null references workshops(id) on delete cascade,
  client_id    uuid not null references partner_clients(id) on delete cascade,
  name         text not null,
  make         text,
  model        text,
  reg_no       text,       -- matches machines.reg_no, so a copy is a straight copy
  serial_no    text,
  year         int,
  notes        text,
  -- The `machines` row created when this was copied into the linked farm, so the copy is
  -- traceable and cannot silently happen twice.
  machine_id   uuid,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid
);
create index partner_client_vehicles_client_idx on partner_client_vehicles(client_id);

-- ── RLS: a partner's book is the partner's ───────────────────────────────────
-- A new scoping axis (workshop, not farm), so it is spelled out rather than reusing a
-- farm helper: your own workshop's rows, or rr_admin. No farm user can read a partner's
-- private notes about them, which is correct — these are the partner's working records,
-- not a shared document.
do $do$
declare t text;
begin
  foreach t in array array['partner_clients', 'partner_client_vehicles'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated '
                   'using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()))', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated '
                   'with check (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated '
                   'using (app.is_rr_admin() or workshop_id = app.user_workshop_id()) '
                   'with check (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated '
                   'using (app.is_rr_admin() or workshop_id = app.user_workshop_id())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %1$I_audit after insert or update or delete on public.%1$I '
                   'for each row execute function app_audit()', t);
  end loop;
end $do$;
-- anon gets ZERO access (0102 default privileges revoke it; no anon policy exists).

-- ── A partner may ASK to be connected — nothing more ─────────────────────────
-- 0101's wl_ins allows only rr_admin or a member of the farm. This adds the partner's
-- side of the handshake, deliberately narrow:
--   * only for its OWN workshop, and
--   * only as 'pending', which `app.has_farm_access` does not count — so raising one
--     grants exactly nothing until the farm approves it.
-- Approval remains the farm's alone: wl_upd still covers only rr_admin and the farm, so
-- a workshop cannot promote its own request.
create policy wl_ins_request on workshop_links for insert to authenticated
  with check (
    workshop_id = app.user_workshop_id()
    and status = 'pending'
  );

comment on table partner_clients is
  'A partner''s own customer book (F15). Workshop-scoped, NOT a grant: access to a farm '
  'still comes solely from an active workshop_link. farm_id here is informational.';
comment on column partner_clients.synced_at is
  'When this client''s notebook vehicles were copied into the linked farm''s fleet. '
  'Set once, so the copy is offered once and a fleet cannot be duplicated by a second press.';
