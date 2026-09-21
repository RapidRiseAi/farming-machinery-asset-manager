-- 20260921141000_help_requests.sql
-- The door a customer can use, on the case machinery that already exists.
--
-- The `help_request` enum value is added by 20260921140000, in a file of its own, because
-- Postgres refuses to use a new enum value in the transaction that created it.
--
-- WHAT THIS DOES NOT REUSE
-- =============================================================================
-- `app.support_ticket_evidence`. That builder reads five billing tables and assembles an
-- object that LEAVES THE BUILDING, and it is the most sensitive function in this schema. A
-- help request needs the farm, the plan, the role and the screen they were on. Attaching a
-- billing dossier to "the QR code will not scan" would put a card's last four and an
-- attempt history into a support queue for no reason at all.
--
-- WHO IT SPEAKS FOR
-- =============================================================================
-- The signed-in user, established from `auth.uid()` inside the function. Nothing about the
-- farm comes from the caller, so a farmer cannot open a case against somebody else's farm
-- by editing a form field.

-- == Open one ================================================================
create or replace function app.open_help_request(
  p_subject text,
  p_message text,
  -- Where they were and what they were doing. Supplied by the screen, and deliberately
  -- NOT trusted: only the handful of keys below are kept, so a crafted form cannot stuff
  -- arbitrary content into something a person will read and act on.
  p_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_farm    uuid;
  v_role    text;
  v_name    text;
  v_email   text;
  v_plan    text;
  v_farm_nm text;
  v_open    integer;
  v_ticket  uuid;
  v_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if v_subject is null or v_message is null then
    raise exception 'A help request needs a subject and a message.' using errcode = '22023';
  end if;

  select u.farm_id, u.role::text, u.name, u.email
    into v_farm, v_role, v_name, v_email
    from public.users u
   where u.id = v_user and u.active and u.deleted_at is null;
  if v_farm is null then
    raise exception 'Only a farm member can ask for help here.' using errcode = '42501';
  end if;

  select f.name, f.plan::text into v_farm_nm, v_plan
    from public.farms f where f.id = v_farm;

  -- A support form is a spam vector, and the queue it fills is read by a person. Five open
  -- at once is more than any real farm needs and far fewer than a stuck retry loop would
  -- produce. Resolved ones do not count, so somebody with a genuine run of problems is
  -- never locked out.
  select count(*) into v_open from public.support_tickets
   where farm_id = v_farm and kind = 'help_request' and status in ('open', 'waiting');
  if v_open >= 5 then
    raise exception 'You already have five questions open with us. We will come back to you on those first.'
      using errcode = '53000';
  end if;

  v_ticket := app.open_support_ticket(
    'help_request'::support_ticket_kind,
    left(v_subject, 200),
    v_farm,
    null, null, null, null,
    -- A person is waiting for an answer. Two working days is the promise the escalation
    -- clock then measures against.
    now() + interval '2 days'
  );

  -- The evidence, built here rather than by the billing builder. Everything in it is
  -- either what they typed or what their own farm already is.
  update public.support_tickets
     set evidence = jsonb_build_object(
           'source',   'in_app',
           'message',  left(v_message, 4000),
           'farm',     jsonb_build_object('id', v_farm, 'name', v_farm_nm, 'plan', v_plan),
           'asked_by', jsonb_build_object(
                         'id', v_user, 'name', v_name, 'email', v_email, 'role', v_role),
           -- Only these keys, whatever else the form posted.
           'context',  jsonb_strip_nulls(jsonb_build_object(
                         'path',        p_context->>'path',
                         'app_version', p_context->>'app_version',
                         'locale',      p_context->>'locale'))
         )
   where id = v_ticket;

  return v_ticket;
end $$;

revoke execute on function app.open_help_request(text, text, jsonb) from public, anon;
grant  execute on function app.open_help_request(text, text, jsonb) to authenticated, service_role;

create or replace function public.open_help_request(
  p_subject text, p_message text, p_context jsonb default '{}'::jsonb
) returns uuid
language sql
security definer
set search_path = public, app, pg_temp
as $$
  select app.open_help_request(p_subject, p_message, p_context);
$$;

revoke execute on function public.open_help_request(text, text, jsonb) from public, anon;
grant  execute on function public.open_help_request(text, text, jsonb) to authenticated, service_role;

comment on function public.open_help_request(text, text, jsonb) is
  'A farmer asking for help from inside the product. Speaks for the signed-in user only: '
  'the farm comes from auth.uid(), never from the caller. Carries no billing evidence.';

-- == See your own ============================================================
--
-- A function rather than a policy on `support_tickets`, on purpose. That table also holds
-- disputes and refund cases whose `evidence` is a billing dossier, and widening its SELECT
-- policy to farm members would be one WHERE clause away from handing a farm the contents
-- of every case about them. This returns four columns and no evidence at all.
create or replace function app.my_help_requests()
returns table (
  id          uuid,
  subject     text,
  status      support_ticket_status,
  created_at  timestamptz,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.subject, s.status, s.created_at, s.resolved_at
    from public.support_tickets s
    join public.users u on u.id = auth.uid()
   where s.kind = 'help_request'
     and s.farm_id = u.farm_id
     and u.active and u.deleted_at is null
   order by s.created_at desc
   limit 50;
$$;

revoke execute on function app.my_help_requests() from public, anon;
grant  execute on function app.my_help_requests() to authenticated, service_role;

create or replace function public.my_help_requests()
returns table (
  id          uuid,
  subject     text,
  status      support_ticket_status,
  created_at  timestamptz,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select * from app.my_help_requests();
$$;

revoke execute on function public.my_help_requests() from public, anon;
grant  execute on function public.my_help_requests() to authenticated, service_role;

comment on function public.my_help_requests() is
  'The questions this farm has asked, and whether they are answered. Four columns and no '
  'evidence: support_tickets also holds disputes whose evidence is a billing dossier.';
