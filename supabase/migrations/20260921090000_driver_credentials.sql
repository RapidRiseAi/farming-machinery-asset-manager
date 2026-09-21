-- 20260921090000_driver_credentials.sql
-- The licence that belongs to the PERSON, not to the vehicle.
--
-- `licences` (0260) tracks the disc on the windscreen. Nothing in this product has ever
-- tracked the card in the driver's pocket, their driving licence code, their PrDP, the
-- competency certificate for the loader, the medical the PrDP depends on. So the AARTO
-- nomination flow (0370/0371) will happily nominate a driver whose own licence expired
-- four months ago, name them to the authority as the person who was driving, and never
-- once say that the farm has just put that in writing.
--
-- THE PERSON MAY NOT BE A USER
-- =============================================================================
-- Most people who drive a farm's vehicles never sign in: this product's own design has
-- workers using the no-login QR page. `fines` already solved this, `driver_user_id` OR a
-- free-text `driver_name`, and this table uses exactly the same shape rather than
-- inventing a second idea of who a person is. One of the two, never both, never neither.
--
-- WHO MAY READ IT
-- =============================================================================
-- A medical certificate is health information; §26 of POPIA makes it special personal
-- information, and a licence code plus an ID-linked permit is not far behind. So SELECT is
-- narrower than `has_farm_access` for the first time in this schema:
--
--   * owner, manager, rr_admin  → the whole farm's records, because somebody has to
--     answer for them when a truck is stopped;
--   * anybody else signed in    → their OWN row and nothing else;
--   * WORKSHOP STAFF            → nothing at all, even with an active link. A workshop
--     gets access to a farm's machines, not to its employees' medicals.
--
-- Writes are owner/manager only, in the DATABASE and not merely in the action. Everywhere
-- else in this schema a write policy is farm-scoped and the route decides the role; here
-- the row is somebody's personal file and RLS is the guarantor of that, not a convention.

create type driver_credential_type as enum (
  'drivers_licence',  -- the card: code B, C1, EC…
  'prdp',             -- Professional Driving Permit: G(oods), P(assengers), D(angerous goods)
  'competency',       -- operator competency: forklift, TLB, front-end loader, chainsaw
  'medical',          -- certificate of fitness, the PrDP depends on it
  'induction',        -- site or safety induction that has to be redone
  'other'
);

create table driver_credentials (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null,
  -- Exactly one of these. A known operator who signs in, or a name written on a page.
  user_id            uuid references users(id),
  person_name        text,
  type               driver_credential_type not null default 'drivers_licence',
  -- 'EC', 'C1', 'G', what is printed on the card. Free text on purpose: the codes differ
  -- by document and an enum here would be wrong within a year.
  code               text,
  number             text,
  issued_on          date,
  -- Nullable: an induction may have no expiry, and a row with no date simply never
  -- reminds rather than reminding on a date somebody invented.
  expiry_date        date,
  reminder_lead_days int not null default 30,
  notes              text,
  -- Dedupe bookkeeping for the engine below, exactly as licences 0260 does it.
  notified_status    expiry_status,
  last_notified_at   timestamptz,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  -- No `updated_at`. Nothing in this schema maintains one automatically, and a column that
  -- says `now()` for ever is worse than no column: the append-only `audit_log` trigger
  -- below already records every change and when it happened, which is this project's
  -- history mechanism.
  deleted_at         timestamptz,
  deleted_by         uuid,
  constraint driver_credentials_farm_fk foreign key (farm_id) references farms(id),
  constraint driver_credentials_who_ck check (
    (user_id is not null and nullif(btrim(person_name), '') is null)
    or (user_id is null and nullif(btrim(person_name), '') is not null)
  ),
  constraint driver_credentials_lead_ck check (reminder_lead_days between 0 and 365),
  constraint driver_credentials_dates_ck check (
    issued_on is null or expiry_date is null or expiry_date >= issued_on
  )
);

create index driver_credentials_farm_idx   on driver_credentials(farm_id) where deleted_at is null;
create index driver_credentials_user_idx   on driver_credentials(user_id) where deleted_at is null;
create index driver_credentials_expiry_idx on driver_credentials(expiry_date) where deleted_at is null;

comment on table driver_credentials is
  'What a person is licensed to do and until when, their driving licence, PrDP, '
  'competency certificates and medicals. Personal information: read by owner/manager, or '
  'by the person themselves, and never by linked workshop staff.';
comment on column driver_credentials.person_name is
  'Used when the driver is not a signed-in user, which on most farms is most drivers. '
  'Mutually exclusive with user_id, the same shape fines.driver_name uses.';

-- == RLS =====================================================================
alter table driver_credentials enable row level security;
alter table driver_credentials force  row level security;

-- `app.current_app_role()` rather than a farm-membership lookup, because the question is
-- what this person's ROLE is, and `workshop` must fall through every branch.
create policy driver_credentials_sel on driver_credentials for select to authenticated
  using (
    deleted_at is null
    and app.has_farm_access(farm_id)
    and (
      app.current_app_role() in ('rr_admin', 'owner', 'manager')
      or user_id = auth.uid()
    )
  );

create policy driver_credentials_ins on driver_credentials for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.current_app_role() in ('rr_admin', 'owner', 'manager')
  );

create policy driver_credentials_upd on driver_credentials for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.current_app_role() in ('rr_admin', 'owner', 'manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.current_app_role() in ('rr_admin', 'owner', 'manager')
  );

create policy driver_credentials_del on driver_credentials for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.current_app_role() in ('rr_admin', 'owner', 'manager')
  );

grant select, insert, update, delete on driver_credentials to authenticated;
grant all on driver_credentials to service_role;

create trigger driver_credentials_audit
  after insert or update or delete on driver_credentials
  for each row execute function app_audit();

-- == Who could legally drive, and on what day ================================
--
-- The question the AARTO screen has to be able to ask: on the day of this offence, was the
-- person we are about to name to the authority actually licensed?
--
-- It takes a DATE rather than assuming today, because a nomination is always about a day
-- in the past, and "their licence is fine now" is not an answer to "were they licensed on
-- the 14th of June".
--
-- SECURITY INVOKER: it reads `driver_credentials` as the caller, so the policy above
-- decides what it can see. A manager gets the farm's answer; anybody else gets their own
-- or nothing, which is the same rule the table has, arrived at the same way.
create or replace function app.driver_credential_lapses(
  p_farm uuid, p_user uuid, p_name text, p_on date
) returns table (
  credential_id uuid,
  type          driver_credential_type,
  code          text,
  expiry_date   date,
  status        expiry_status
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select c.id, c.type, c.code, c.expiry_date,
         case when c.expiry_date < coalesce(p_on, current_date)
              then 'expired'::expiry_status
              else 'ok'::expiry_status
         end
    from public.driver_credentials c
   where c.farm_id = p_farm
     and c.deleted_at is null
     and c.expiry_date is not null
     -- The same either/or the table is built on: match the user when there is one, and
     -- fall back to the name when the driver is somebody who never signs in. Compared
     -- case- and whitespace-insensitively, because a name typed twice is typed twice.
     and (
       (p_user is not null and c.user_id = p_user)
       or (p_user is null and p_name is not null
           and c.user_id is null
           and lower(btrim(c.person_name)) = lower(btrim(p_name)))
     )
     and c.expiry_date < coalesce(p_on, current_date)
   order by c.expiry_date;
$$;

grant execute on function app.driver_credential_lapses(uuid, uuid, text, date)
  to authenticated, service_role;

-- PostgREST reaches `public` only, so the screen needs a wrapper or the function does not
-- exist as far as the app is concerned. SECURITY INVOKER the whole way down, the wrapper
-- adds reachability, never privilege.
create or replace function public.driver_credential_lapses(
  p_farm uuid, p_user uuid, p_name text, p_on date
) returns table (
  credential_id uuid,
  type          driver_credential_type,
  code          text,
  expiry_date   date,
  status        expiry_status
)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select * from app.driver_credential_lapses(p_farm, p_user, p_name, p_on);
$$;

revoke execute on function public.driver_credential_lapses(uuid, uuid, text, date) from public, anon;
grant  execute on function public.driver_credential_lapses(uuid, uuid, text, date)
  to authenticated, service_role;

comment on function public.driver_credential_lapses(uuid, uuid, text, date) is
  'Which of this driver''s credentials had already expired on a given day. Asked before a '
  'farm names somebody to the authority under AARTO, because a nomination is a statement '
  'about a day in the past and "their licence is fine now" does not answer it.';

-- == Reminders ===============================================================
-- A separate engine with its own cron wrapper, following 0371 rather than extending
-- 0263: a new reminder source has been added by adding a function twice now, and rewriting
-- the warranty and vehicle-licence loops to get a third one is two working loops put at
-- risk for nothing.
create or replace function app.enqueue_driver_credential_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_status        expiry_status;
  v_template      text;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should        boolean;
begin
  for r in
    select c.id, c.farm_id, c.type, c.code, c.number, c.expiry_date, c.reminder_lead_days,
           c.notified_status, c.last_notified_at,
           coalesce(nullif(btrim(c.person_name), ''), u.name, u.email, '-') as person,
           f.settings
      from driver_credentials c
      left join users u on u.id = c.user_id
      join farms f on f.id = c.farm_id
     where c.deleted_at is null
       and c.expiry_date is not null
       and f.deleted_at is null and f.status in ('trial', 'active')
       -- A person who has left. Their file stays for the record; the farm is not reminded
       -- every week about the medical of somebody who no longer works there.
       and (c.user_id is null or (u.active and u.deleted_at is null))
  loop
    v_status := app.expiry_status_of(
      r.expiry_date,
      coalesce(r.reminder_lead_days, (r.settings->>'driver_credential_lead_days')::int, 30));

    if v_status is null or v_status = 'ok' then
      if r.notified_status is distinct from v_status then
        update driver_credentials
           set notified_status = v_status, last_notified_at = null
         where id = r.id;
      end if;
      continue;
    end if;

    v_should := (v_status is distinct from r.notified_status)
             or (v_status = 'expired' and r.notified_status = 'expired'
                 and r.last_notified_at is not null
                 and r.last_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_template := case when v_status = 'expired'
                       then 'driver_credential_expired'
                       else 'driver_credential_expiring' end;
    -- The person's NAME and the kind of document, and nothing else about them. A
    -- notification is delivered by push and by email and read on a phone somebody else may
    -- be holding; a licence number in it is a licence number out of the building.
    v_payload := jsonb_build_object(
      'credential_id', r.id,
      'person',        r.person,
      'credential',    r.type,
      'code',          r.code,
      'status',        v_status,
      'expiry_date',   r.expiry_date
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, v_template, v_payload, v_deliver_after);
    update driver_credentials
       set notified_status = v_status, last_notified_at = now()
     where id = r.id;
  end loop;
end $$;

revoke execute on function app.enqueue_driver_credential_reminders() from public, anon, authenticated;
grant  execute on function app.enqueue_driver_credential_reminders() to service_role;

create or replace function public.cron_enqueue_driver_credentials() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_driver_credential_reminders(); end $$;

revoke execute on function public.cron_enqueue_driver_credentials() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_driver_credentials() to service_role;
