-- 20260921100000_incidents_and_claims.sql
-- Accidents, and the insurance claim that follows one.
--
-- `faults` covers breakdowns: something stopped working and somebody must fix it. An
-- accident is a different object with a different clock. It has a SAPS case number, a
-- third party with their own insurer, an excess, a claim reference, and a settlement that
-- arrives months later — and until now a farm had nowhere to put any of it except the
-- notes field on a fault, where nothing reminds anybody that a claim lodged in March has
-- still not been paid in July.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- Post money. A settlement is money coming IN against a repair whose cost is already on a
-- job card, and the negative-amount model for that is an open founder decision
-- (`docs/BILLING.md` §11b, the partner side at 0422). Recording a claim that has been paid
-- and posting a credit are two different acts; this migration does the first and says so
-- rather than guessing at the second and leaving a ledger nobody can reconcile.
--
-- THE REPAIR IS A JOB CARD, NOT A FIELD HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- `job_card_id` points at the existing repair rather than duplicating its parts, labour
-- and VAT. What the accident cost is what the job card cost; this row records what came
-- back and what the farm carried.
--
-- THE THIRD PARTY IS SOMEBODY ELSE'S PERSONAL INFORMATION
-- ─────────────────────────────────────────────────────────────────────────────
-- A name, a phone number and a registration belonging to a person who is not a customer
-- of this product. Recorded because a claim cannot be made without it, kept minimal on
-- purpose (no ID numbers, no addresses), and visible only inside the farm — a linked
-- workshop can see the machine and the job card and has no business with the other
-- driver's details, which is why SELECT is role-aware rather than `has_farm_access`.

create type incident_kind as enum (
  'collision',           -- with another vehicle
  'single_vehicle',      -- rolled it, hit a gate, into a ditch
  'fire',
  'theft',
  'hijacking',
  'vandalism',
  'third_party_damage',  -- our machine damaged somebody else's property
  'injury',              -- a person was hurt; the machine may be untouched
  'other'
);

-- Where the claim has got to. `no_claim` is a first-class answer, not an absence: most
-- farm incidents are below the excess and a farm decides not to claim, and "we decided
-- not to" must be distinguishable from "nobody has done anything about it".
create type incident_status as enum (
  'reported',
  'investigating',
  'no_claim',
  'claim_lodged',
  'claim_settled',
  'claim_rejected',
  'closed'
);

create table incidents (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null,
  machine_id            uuid not null,
  kind                  incident_kind   not null default 'collision',
  status                incident_status not null default 'reported',
  occurred_at           timestamptz not null default now(),
  location              text,
  description           text,

  -- Who was driving. The same either/or the rest of this schema uses — a signed-in
  -- operator, or a name — and here BOTH may be null: a machine burns down in a shed with
  -- nobody near it, and inventing a driver for that would be a false record.
  driver_user_id        uuid references users(id),
  driver_name           text,

  -- The police case. An insurer will not move without it on a theft or a collision, and
  -- it is the number a farm can never find when they need it.
  saps_case_number      text,
  saps_station          text,

  -- The other party. Minimal by design: enough to lodge a claim, no more.
  third_party_name      text,
  third_party_contact   text,
  third_party_reg_no    text,
  third_party_insurer   text,

  injuries              boolean not null default false,
  injury_notes          text,

  -- The claim.
  insurer               text,
  claim_number          text,
  claim_lodged_on       date,
  -- VAT-inclusive cents, as the insurer states them. NOT ex-VAT like the rest of this
  -- schema's money, and named so: an excess and a settlement are figures a person reads
  -- off a letter, and silently re-basing them would make every figure on this screen
  -- disagree with the document it was copied from.
  excess_incl_cents     bigint,
  claimed_incl_cents    bigint,
  settled_incl_cents    bigint,
  settled_on            date,
  claim_notes           text,

  -- The repair, if there was one. Composite FK so a job card from another farm cannot be
  -- attached, which is the same rule every machine-keyed table here follows.
  job_card_id           uuid,

  -- Dedupe bookkeeping for the chase engine below, mirroring licences 0260.
  chase_notified_status expiry_status,
  chase_notified_at     timestamptz,

  reported_by           uuid references users(id),
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid,

  constraint incidents_machine_fk  foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint incidents_farm_fk     foreign key (farm_id) references farms(id),
  constraint incidents_jobcard_fk  foreign key (job_card_id, farm_id) references job_cards(id, farm_id),
  constraint incidents_money_ck check (
    (excess_incl_cents  is null or excess_incl_cents  >= 0)
    and (claimed_incl_cents is null or claimed_incl_cents >= 0)
    and (settled_incl_cents is null or settled_incl_cents >= 0)
  ),
  -- A settled claim has a figure and a date, or it is not settled. Without this the
  -- "outstanding claims" total silently omits the ones somebody marked settled and never
  -- filled in, which is the number the whole feature exists to produce.
  constraint incidents_settled_ck check (
    status <> 'claim_settled'
    or (settled_incl_cents is not null and settled_on is not null)
  ),
  constraint incidents_lodged_ck check (
    status not in ('claim_lodged', 'claim_settled', 'claim_rejected')
    or claim_lodged_on is not null
  )
);

create index incidents_farm_idx    on incidents(farm_id) where deleted_at is null;
create index incidents_machine_idx on incidents(machine_id, occurred_at desc);
create index incidents_status_idx  on incidents(farm_id, status) where deleted_at is null;
create index incidents_claim_idx   on incidents(claim_lodged_on) where deleted_at is null;

comment on table incidents is
  'Accidents, thefts and injuries, and the insurance claim that follows. Records the '
  'claim; posts no money — a settlement against a repair is an open decision '
  '(docs/BILLING.md §11b). The repair itself is the linked job card.';
comment on column incidents.excess_incl_cents is
  'VAT-INCLUSIVE, unlike the rest of this schema. These are figures copied off an '
  'insurer''s letter and must match it.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table incidents enable row level security;
alter table incidents force  row level security;

-- Role-aware SELECT, the 0341 pattern `fines` already uses: an operator sees incidents on
-- the machines assigned to them and nothing else. That also keeps the third party's name
-- and number away from everyone who has no reason for it.
create policy incidents_sel on incidents for select to authenticated
  using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id));
create policy incidents_ins on incidents for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy incidents_upd on incidents for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy incidents_del on incidents for delete to authenticated
  using (app.has_farm_access(farm_id));

grant select, insert, update, delete on incidents to authenticated;
grant all on incidents to service_role;

create trigger incidents_audit
  after insert or update or delete on incidents
  for each row execute function app_audit();

-- ── The claim nobody chased ─────────────────────────────────────────────────
--
-- An insurance claim is money the farm is owed, and the only thing that makes it arrive is
-- somebody asking. A claim lodged in March and still open in July is the single most
-- expensive row this table will ever hold, and nothing else in the product would ever
-- mention it again.
--
-- Fires once when a lodged claim passes the farm's threshold, then weekly. The same
-- dedupe shape as every other reminder here: a stored status, and a re-fire only after
-- seven days, so a farm that cannot do anything about it today is not told again tomorrow.
create or replace function app.enqueue_incident_claim_chases() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_days          integer;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should        boolean;
begin
  for r in
    select i.id, i.farm_id, i.machine_id, i.claim_number, i.insurer, i.claim_lodged_on,
           i.claimed_incl_cents, i.chase_notified_status, i.chase_notified_at,
           m.name as machine_name, f.settings
      from incidents i
      join machines m on m.id = i.machine_id
      join farms f on f.id = i.farm_id
     where i.deleted_at is null
       and i.status = 'claim_lodged'
       and i.claim_lodged_on is not null
       and m.deleted_at is null
       and f.deleted_at is null and f.status in ('trial', 'active')
  loop
    -- 30 days by default. A month is roughly when a farm should start asking, and the
    -- farms that know their insurer is slower can say so.
    v_days := coalesce((r.settings->>'claim_chase_days')::int, 30);
    if current_date < r.claim_lodged_on + v_days then
      -- Not yet. Clear any marker so a claim re-lodged later starts its clock again.
      if r.chase_notified_status is not null then
        update incidents set chase_notified_status = null, chase_notified_at = null
         where id = r.id;
      end if;
      continue;
    end if;

    v_should := (r.chase_notified_status is distinct from 'expired'::expiry_status)
             or (r.chase_notified_at is not null
                 and r.chase_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_payload := jsonb_build_object(
      'incident_id',  r.id,
      'machine_id',   r.machine_id,
      'machine_name', r.machine_name,
      'insurer',      r.insurer,
      'claim_number', r.claim_number,
      'lodged_on',    r.claim_lodged_on,
      'days',         current_date - r.claim_lodged_on,
      'amount_cents', r.claimed_incl_cents
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'claim_outstanding', v_payload, v_deliver_after);
    update incidents
       set chase_notified_status = 'expired'::expiry_status, chase_notified_at = now()
     where id = r.id;
  end loop;
end $$;

revoke execute on function app.enqueue_incident_claim_chases() from public, anon, authenticated;
grant  execute on function app.enqueue_incident_claim_chases() to service_role;

create or replace function public.cron_enqueue_claim_chases() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_incident_claim_chases(); end $$;

revoke execute on function public.cron_enqueue_claim_chases() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_claim_chases() to service_role;
