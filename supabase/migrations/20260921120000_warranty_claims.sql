-- 20260921120000_warranty_claims.sql
-- "Was this under warranty?", turned into money recovered.
--
-- Warranty EXPIRY has been tracked since 0003 and reminded on since 0263: the farm is told
-- before cover runs out. What has never existed is the other half. A machine breaks while
-- it is still covered, a job card is raised, the parts and labour are paid for by the
-- farm, and whether anybody ever claimed it back from the dealer is not recorded anywhere.
--
-- THE QUESTION IS ABOUT THE DAY OF THE REPAIR
-- =============================================================================
-- `app.warranty_status` answers "is this machine under warranty now". A claim is about a
-- repair that happened, so the question is whether the machine was covered on the job
-- card's `date_in` and at its `meter_reading`. Six weeks later the answer to the first
-- question can be no while the answer to the second is still yes, and that gap is exactly
-- where the money is lost.
--
-- MONEY IS EX-VAT, LIKE THE JOB CARD IT COMES FROM
-- =============================================================================
-- Deliberately unlike `incidents`, whose figures are copied off an insurer's letter. A
-- warranty claim is measured against a job card, whose parts, labour and totals are all
-- ex-VAT with a rate captured beside them, and a claim that used a different basis could
-- not be compared with the repair it is about.
--
-- A CLAIM CANNOT BE WORTH MORE THAN THE REPAIR
-- =============================================================================
-- Enforced, because the number this feature exists to produce is "how much of what we
-- spent came back", and a claim larger than its own job card makes that number nonsense.

create type warranty_claim_status as enum (
  'draft',      -- being prepared; nothing has been sent
  'submitted',  -- with the dealer or manufacturer, waiting
  'approved',   -- they agreed; money not in yet
  'paid',       -- recovered
  'rejected',   -- they said no
  'withdrawn'   -- we decided not to pursue it
);

create table warranty_claims (
  id                     uuid primary key default gen_random_uuid(),
  farm_id                uuid not null,
  machine_id             uuid not null,
  -- Required. A warranty claim is always about a repair, and one without a job card has no
  -- parts, no labour and no amount to be measured against.
  job_card_id            uuid not null,

  -- Who it goes to. Free text rather than a link to `partners`: the dealer a warranty is
  -- claimed from is frequently not a contractor this farm works with, and inventing a
  -- partner record to file a claim would be an obstacle at exactly the wrong moment.
  supplier               text,
  reference              text,
  status                 warranty_claim_status not null default 'draft',
  submitted_on           date,
  decided_on             date,

  -- Ex-VAT cents, the job card's basis.
  claimed_ex_vat_cents   bigint,
  recovered_ex_vat_cents bigint,
  notes                  text,

  -- What the cover looked like when the claim was raised, frozen. The machine's warranty
  -- dates can be corrected later; what was believed at the time is part of the record.
  covered_by_date        boolean,
  covered_by_hours       boolean,

  -- Dedupe bookkeeping for the chase engine below.
  chase_notified_status  expiry_status,
  chase_notified_at      timestamptz,

  created_by             uuid references users(id),
  created_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  deleted_by             uuid,

  constraint warranty_claims_machine_fk  foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint warranty_claims_jobcard_fk  foreign key (job_card_id, farm_id) references job_cards(id, farm_id),
  constraint warranty_claims_farm_fk     foreign key (farm_id) references farms(id),
  constraint warranty_claims_money_ck check (
    (claimed_ex_vat_cents   is null or claimed_ex_vat_cents   >= 0)
    and (recovered_ex_vat_cents is null or recovered_ex_vat_cents >= 0)
  ),
  -- Paid means a figure and a date, or it is not paid. Same rule the insurance side has,
  -- for the same reason: a row somebody ticked off and never filled in would quietly
  -- shrink "still owed".
  constraint warranty_claims_paid_ck check (
    status <> 'paid' or (recovered_ex_vat_cents is not null and decided_on is not null)
  ),
  constraint warranty_claims_submitted_ck check (
    status in ('draft', 'withdrawn') or submitted_on is not null
  )
);

-- One LIVE claim per job card. Two claims against one repair is a double recovery on paper
-- and an argument with the dealer in practice.
--
-- A partial unique index, not `unique (job_card_id, deleted_at)`: NULLs are distinct in a
-- unique constraint, so that version would have let any number of live claims through
-- while looking like it forbade them.
create unique index warranty_claims_one_live_per_job_card
  on warranty_claims(job_card_id) where deleted_at is null;

create index warranty_claims_farm_idx    on warranty_claims(farm_id) where deleted_at is null;
create index warranty_claims_machine_idx on warranty_claims(machine_id);
create index warranty_claims_status_idx  on warranty_claims(farm_id, status) where deleted_at is null;

comment on table warranty_claims is
  'What was claimed back from a dealer for a repair done under warranty, and what came '
  'back. Money is EX-VAT, matching the job card it is measured against.';

-- A claim cannot be worth more than the repair it is about. A trigger rather than a check
-- constraint because the limit lives on another table.
create or replace function app.warranty_claim_within_job_card() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_total bigint;
begin
  select total_cents into v_total from public.job_cards
   where id = new.job_card_id and deleted_at is null;
  if v_total is null then
    raise exception 'That job card does not exist.' using errcode = '23503';
  end if;
  -- Only when the job card HAS a total. An open job card is still being costed, and
  -- refusing a claim against it would stop a farm recording the claim on the day they
  -- posted it, which is the day they will remember to.
  if v_total > 0 then
    if coalesce(new.claimed_ex_vat_cents, 0) > v_total then
      raise exception 'A claim cannot be more than the repair it is for (% > %).',
        new.claimed_ex_vat_cents, v_total using errcode = '23514';
    end if;
    if coalesce(new.recovered_ex_vat_cents, 0) > v_total then
      raise exception 'Recovered cannot be more than the repair it is for (% > %).',
        new.recovered_ex_vat_cents, v_total using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger warranty_claims_within_job_card
  before insert or update on warranty_claims
  for each row execute function app.warranty_claim_within_job_card();

-- == RLS =====================================================================
alter table warranty_claims enable row level security;
alter table warranty_claims force  row level security;

-- Role-aware SELECT, the pattern `fines` and `incidents` use: an operator sees claims on
-- the machines assigned to them. Money is behind `app.can_view_farm_costs` everywhere else
-- in this schema, and the amounts here are the job card's amounts, which that gate already
-- governs on the job card itself.
create policy warranty_claims_sel on warranty_claims for select to authenticated
  using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id));
create policy warranty_claims_ins on warranty_claims for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy warranty_claims_upd on warranty_claims for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy warranty_claims_del on warranty_claims for delete to authenticated
  using (app.has_farm_access(farm_id));

grant select, insert, update, delete on warranty_claims to authenticated;
grant all on warranty_claims to service_role;

create trigger warranty_claims_audit
  after insert or update or delete on warranty_claims
  for each row execute function app_audit();

-- == Was it under warranty when this repair happened? ========================
--
-- The question the whole feature turns on, asked about the JOB CARD's day and meter
-- reading rather than about today. Returns both bases separately, because they expire
-- independently and a farm arguing with a dealer needs to know which one still held.
--
-- `date_in` null falls back to the job card's creation day: a repair captured without a
-- date still happened, and refusing to answer is less useful than answering from the day
-- it was written down.
create or replace function app.job_card_warranty_cover(p_job_card uuid)
returns table (
  job_card_id     uuid,
  machine_id      uuid,
  on_date         date,
  meter_reading   numeric,
  covered_by_date boolean,
  covered_by_hours boolean,
  covered          boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    j.id,
    j.machine_id,
    coalesce(j.date_in, j.created_at::date),
    j.meter_reading,
    case when m.warranty_expiry_date is null then null
         else m.warranty_expiry_date >= coalesce(j.date_in, j.created_at::date) end,
    case when m.meter_type <> 'hours' or m.warranty_expiry_hours is null
              or j.meter_reading is null then null
         else j.meter_reading <= m.warranty_expiry_hours end,
    -- Covered when at least one basis says yes and neither says no. A machine past its
    -- hours but inside its date is NOT covered, and saying otherwise would send a farm to
    -- a dealer with a claim that gets refused.
    case
      when m.warranty_expiry_date is null and m.warranty_expiry_hours is null then null
      when (m.warranty_expiry_date is not null
            and m.warranty_expiry_date < coalesce(j.date_in, j.created_at::date))
        or (m.meter_type = 'hours' and m.warranty_expiry_hours is not null
            and j.meter_reading is not null and j.meter_reading > m.warranty_expiry_hours)
        then false
      else true
    end
  from public.job_cards j
  join public.machines m on m.id = j.machine_id
  where j.id = p_job_card
    and j.deleted_at is null
    and app.row_visible_to_role(j.farm_id, j.machine_id);
$$;

grant execute on function app.job_card_warranty_cover(uuid) to authenticated, service_role;

-- PostgREST reaches `public` only. SECURITY INVOKER the whole way down: the wrapper adds
-- reachability, never privilege.
create or replace function public.job_card_warranty_cover(p_job_card uuid)
returns table (
  job_card_id     uuid,
  machine_id      uuid,
  on_date         date,
  meter_reading   numeric,
  covered_by_date boolean,
  covered_by_hours boolean,
  covered          boolean
)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select * from app.job_card_warranty_cover(p_job_card);
$$;

revoke execute on function public.job_card_warranty_cover(uuid) from public, anon;
grant  execute on function public.job_card_warranty_cover(uuid) to authenticated, service_role;

comment on function public.job_card_warranty_cover(uuid) is
  'Was the machine under warranty on the day of THIS repair, and at its meter reading? '
  'Both bases answered separately, because they expire independently.';

-- == The claim nobody chased =================================================
-- The same shape as the insurance chase (20260921100000): money the farm is owed, and the
-- only thing that makes it arrive is somebody asking.
create or replace function app.enqueue_warranty_claim_chases() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_days          integer;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should        boolean;
begin
  for r in
    select w.id, w.farm_id, w.machine_id, w.job_card_id, w.reference, w.supplier, w.submitted_on,
           w.claimed_ex_vat_cents, w.chase_notified_status, w.chase_notified_at,
           m.name as machine_name, f.settings
      from warranty_claims w
      join machines m on m.id = w.machine_id
      join farms f on f.id = w.farm_id
     where w.deleted_at is null
       and w.status in ('submitted', 'approved')
       and w.submitted_on is not null
       and m.deleted_at is null
       and f.deleted_at is null and f.status in ('trial', 'active')
  loop
    -- 30 days by default; a farm whose dealer is slower can say so.
    v_days := coalesce((r.settings->>'warranty_chase_days')::int, 30);
    if current_date < r.submitted_on + v_days then
      if r.chase_notified_status is not null then
        update warranty_claims set chase_notified_status = null, chase_notified_at = null
         where id = r.id;
      end if;
      continue;
    end if;

    v_should := (r.chase_notified_status is distinct from 'expired'::expiry_status)
             or (r.chase_notified_at is not null
                 and r.chase_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_payload := jsonb_build_object(
      'claim_id',     r.id,
      -- The repair the claim is about. The reminder deep-links straight to it, because
      -- that is where the reference, the amount and the dealer all are.
      'job_card_id',  r.job_card_id,
      'machine_id',   r.machine_id,
      'machine_name', r.machine_name,
      'supplier',     r.supplier,
      'reference',    r.reference,
      'submitted_on', r.submitted_on,
      'days',         current_date - r.submitted_on,
      'amount_cents', r.claimed_ex_vat_cents
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'warranty_claim_outstanding', v_payload, v_deliver_after);
    update warranty_claims
       set chase_notified_status = 'expired'::expiry_status, chase_notified_at = now()
     where id = r.id;
  end loop;
end $$;

revoke execute on function app.enqueue_warranty_claim_chases() from public, anon, authenticated;
grant  execute on function app.enqueue_warranty_claim_chases() to service_role;

create or replace function public.cron_enqueue_warranty_chases() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_warranty_claim_chases(); end $$;

revoke execute on function public.cron_enqueue_warranty_chases() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_warranty_chases() to service_role;
