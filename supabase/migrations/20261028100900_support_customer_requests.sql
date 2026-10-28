-- 20261028100900_support_customer_requests.sql
-- The customer's side of support: ask, see your own requests, read the answer, reply.
--
-- WHAT CHANGED FROM 20260921141000
--   * Anyone signed in to a farm or a contractor's business may ask, choosing the farm when
--     they have several (a contractor may ask about a linked farm, or about their own
--     business). Rapid Rise itself opens cases from the support desk instead.
--   * Three kinds: a question or problem (help_request), a privacy or deletion request, and
--     a full data export request (owners and managers only: it is the farm's data).
--   * The question is the first message of a conversation (support_ticket_messages), not a
--     key in the evidence. The evidence keeps only the farm, the plan, who asked (id and
--     role) and the screen they came from; never the billing dossier, never an email.
--   * Deadlines come from the support calendar (app.support_due_at), not "+2 days".
--   * Rapid Rise is alerted at once (app.notify_rr_support), unless it is a test case.
--   * Rate limited per person (support_take_message_slot), on top of the five-open ceiling.
--
-- WHO SEES WHAT ("What you have asked")
--   * the person who asked sees their own requests and the answers;
--   * the owner and managers of the farm also see the farm's other requests, except
--     privacy requests (an employee asking about their own personal information) and a
--     contractor's (theirs to see);
--   * nobody else, and never another farm's. support_tickets itself stays Rapid Rise only.
--
-- COMPATIBILITY: the deployed build calls open_help_request(p_subject, p_message, p_context)
-- and my_help_requests() by name; both still resolve, to the new defaulted signatures.

drop function if exists public.open_help_request(text, text, jsonb);
drop function if exists app.open_help_request(text, text, jsonb);
drop function if exists public.my_help_requests();
drop function if exists app.my_help_requests();

-- == Who may see a case ==========================================================
create or replace function app.support_customer_can_see(p_ticket uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.support_tickets t
     where t.id = p_ticket
       and t.kind in ('help_request', 'privacy_request', 'export_request')
       and (
         t.asked_by = auth.uid()
         or (t.kind <> 'privacy_request'
             and t.workshop_id is null
             and t.farm_id is not null
             and app.effective_farm_role(auth.uid(), t.farm_id) in ('owner', 'manager'))
       )
  );
$$;

comment on function app.support_customer_can_see(uuid) is
  'A customer may see a support case they asked, or (not a privacy request, not a contractor''s) '
  'one asked on a farm they own or manage.';

-- == How often a person may write to us ==========================================
-- A support form is a spam vector and a person reads the queue. Twelve messages in fifteen
-- minutes and sixty a day, per person, counted in the shared limiter (20261014090000). The
-- numbers live here, in one place, to be changed in one place.
create or replace function app.support_take_message_slot() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  select l.allowed into v_ok from public.rate_limit_take('support_message', 900, 12) l;
  if not coalesce(v_ok, true) then
    raise exception 'support-slow-down' using errcode = '53400';
  end if;
  select l.allowed into v_ok from public.rate_limit_take('support_message_day', 86400, 60) l;
  if not coalesce(v_ok, true) then
    raise exception 'support-slow-down' using errcode = '53400';
  end if;
end $$;

revoke execute on function app.support_customer_can_see(uuid) from public, anon, authenticated;
revoke execute on function app.support_take_message_slot() from public, anon, authenticated;

-- == Ask ==========================================================================
create or replace function public.open_help_request(
  p_subject text,
  p_message text,
  -- Where they were. Supplied by the screen and NOT trusted: three named keys are kept.
  p_context jsonb default '{}'::jsonb,
  -- The farm it is about: the person's primary farm when null. Checked, never trusted.
  p_farm    uuid default null,
  p_kind    text default 'help_request'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid      uuid := auth.uid();
  v_user     public.users%rowtype;
  v_farm     uuid;
  v_workshop uuid;
  v_role     text;
  v_farm_nm  text;
  v_plan     text;
  v_open     integer;
  v_due      timestamptz;
  v_ticket   uuid;
  v_subject  text := nullif(btrim(coalesce(p_subject, '')), '');
  v_message  text := nullif(btrim(coalesce(p_message, '')), '');
  v_kind     text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'help_request');
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if v_subject is null or v_message is null then
    raise exception 'A help request needs a subject and a message.' using errcode = '22023';
  end if;
  if v_kind not in ('help_request', 'privacy_request', 'export_request') then
    raise exception 'support-kind-invalid' using errcode = '22023';
  end if;

  select * into v_user from public.users u where u.id = v_uid and u.active and u.deleted_at is null;
  if not found then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  if v_user.role = 'rr_admin' then
    raise exception 'Rapid Rise opens cases for a customer from the support desk.' using errcode = '42501';
  elsif v_user.role = 'workshop' then
    v_workshop := v_user.workshop_id;
    if v_workshop is null then
      raise exception 'Only a farm or a contractor can ask for help here.' using errcode = '42501';
    end if;
    if p_farm is not null then
      if not exists (select 1 from public.workshop_links l
                      where l.workshop_id = v_workshop and l.farm_id = p_farm
                        and l.status = 'active' and l.deleted_at is null) then
        raise exception 'support-farm-not-yours' using errcode = '42501';
      end if;
      v_farm := p_farm;
    end if;
    v_role := 'workshop';
    if v_kind = 'export_request' then
      raise exception 'support-export-owner' using errcode = '42501';
    end if;
  else
    v_farm := coalesce(p_farm, v_user.farm_id);
    if v_farm is null then
      raise exception 'Only a farm member can ask for help here.' using errcode = '42501';
    end if;
    v_role := app.effective_farm_role(v_uid, v_farm)::text;
    if v_role is null then
      raise exception 'support-farm-not-yours' using errcode = '42501';
    end if;
    if v_kind = 'export_request' and v_role not in ('owner', 'manager') then
      raise exception 'support-export-owner' using errcode = '42501';
    end if;
  end if;

  -- Five open at once, per farm (or per contractor's business). Resolved ones do not count.
  if v_workshop is not null then
    select count(*) into v_open from public.support_tickets t
     where t.workshop_id = v_workshop and t.status in ('open', 'waiting')
       and t.kind in ('help_request', 'privacy_request', 'export_request');
  else
    select count(*) into v_open from public.support_tickets t
     where t.farm_id = v_farm and t.workshop_id is null and t.status in ('open', 'waiting')
       and t.kind in ('help_request', 'privacy_request', 'export_request');
  end if;
  if v_open >= 5 then
    raise exception 'You already have five questions open with us. We will come back to you on those first.'
      using errcode = '53000';
  end if;

  perform app.support_take_message_slot();

  if v_farm is not null then
    select f.name, f.plan::text into v_farm_nm, v_plan from public.farms f where f.id = v_farm;
  end if;
  v_due := app.support_due_at(now());

  insert into public.support_tickets (
    kind, status, subject, farm_id, workshop_id, asked_by, channel,
    due_at, first_response_due_at, last_customer_at, evidence
  ) values (
    v_kind::support_ticket_kind, 'open', left(v_subject, 200), v_farm, v_workshop, v_uid, 'in_app',
    v_due, v_due, clock_timestamp(),
    jsonb_strip_nulls(jsonb_build_object(
      'source',   'in_app',
      'farm',     case when v_farm is null then null
                       else jsonb_build_object('id', v_farm, 'name', v_farm_nm, 'plan', v_plan) end,
      'asked_by', jsonb_build_object('id', v_uid, 'role', v_role),
      'context',  jsonb_strip_nulls(jsonb_build_object(
                    'path',        left(p_context->>'path', 300),
                    'app_version', left(p_context->>'app_version', 40),
                    'locale',      left(p_context->>'locale', 10)))
    ))
  )
  returning id into v_ticket;

  insert into public.support_ticket_messages (ticket_id, author_id, author_kind, visibility, channel, body)
  values (v_ticket, v_uid, 'customer', 'public', 'in_app', left(v_message, 4000));

  perform app.notify_rr_support(v_ticket, 'support_request_new');
  return v_ticket;
end $$;

comment on function public.open_help_request(text, text, jsonb, uuid, text) is
  'A customer asking Rapid Rise for help (a question, a privacy request, or a full export). '
  'Speaks for the signed-in user; the farm is checked against their own access. Carries no '
  'billing evidence. Alerts Rapid Rise at once unless it is a test case.';

revoke execute on function public.open_help_request(text, text, jsonb, uuid, text) from public, anon;
grant execute on function public.open_help_request(text, text, jsonb, uuid, text) to authenticated, service_role;

-- == What you have asked ========================================================
create or replace function public.my_help_requests(p_farm uuid default null)
returns table (
  id               uuid,
  subject          text,
  kind             text,
  status           support_ticket_status,
  created_at       timestamptz,
  resolved_at      timestamptz,
  mine             boolean,
  asked_by_name    text,
  farm_id          uuid,
  farm_name        text,
  last_staff_at    timestamptz,
  last_customer_at timestamptz,
  answered         boolean
)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.subject, s.kind::text, s.status, s.created_at, s.resolved_at,
         s.asked_by is not distinct from auth.uid(), u.name, s.farm_id, f.name,
         s.last_staff_at, s.last_customer_at,
         s.last_staff_at is not null
           and (s.last_customer_at is null or s.last_staff_at > s.last_customer_at)
    from public.support_tickets s
    left join public.users u on u.id = s.asked_by
    left join public.farms f on f.id = s.farm_id
   where auth.uid() is not null
     and s.kind in ('help_request', 'privacy_request', 'export_request')
     and (
       s.asked_by = auth.uid()
       or (p_farm is not null
           and s.farm_id = p_farm
           and s.workshop_id is null
           and s.kind <> 'privacy_request'
           and app.effective_farm_role(auth.uid(), p_farm) in ('owner', 'manager'))
     )
   order by s.created_at desc
   limit 100;
$$;

comment on function public.my_help_requests(uuid) is
  'The caller''s own support requests, plus (for the owner or a manager of p_farm) that farm''s '
  'other requests except privacy requests. No evidence, no other farm.';

revoke execute on function public.my_help_requests(uuid) from public, anon;
grant execute on function public.my_help_requests(uuid) to authenticated, service_role;

-- == One request and its answers ================================================
create or replace function public.my_help_request(p_ticket uuid) returns jsonb
-- plpgsql, not sql: it calls app.support_next_due, which 20261028100950 creates, and a
-- `language sql` body is checked at CREATE (CLAUDE.md, "A language sql function is parsed").
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (
  select case when app.support_customer_can_see(p_ticket) then (
    select jsonb_build_object(
      'id', t.id,
      'subject', t.subject,
      'kind', t.kind::text,
      'status', t.status::text,
      'created_at', t.created_at,
      'resolved_at', t.resolved_at,
      'mine', t.asked_by is not distinct from auth.uid(),
      'asked_by_name', u.name,
      'farm_name', f.name,
      -- When the answer is promised: the same-day deadline until the first answer, then
      -- the one their latest reply set. Null when nothing is waiting on Rapid Rise.
      'answer_by', app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                        t.first_response_at, t.last_customer_at, t.last_staff_at),
      -- A test farm's or test account's case: the app sends Rapid Rise no email for it.
      'is_test', t.is_test,
      'messages', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', m.id,
                 'author_kind', m.author_kind,
                 -- A customer's name is shown to their own farm; Rapid Rise answers as Rapid Rise.
                 'author_name', case when m.author_kind = 'customer' then au.name end,
                 'mine', m.author_id is not distinct from auth.uid(),
                 'body', m.body,
                 'created_at', m.created_at) order by m.created_at, m.id)
          from public.support_ticket_messages m
          left join public.users au on au.id = m.author_id
         where m.ticket_id = t.id and m.visibility = 'public'), '[]'::jsonb))
      from public.support_tickets t
      left join public.users u on u.id = t.asked_by
      left join public.farms f on f.id = t.farm_id
     where t.id = p_ticket)
  end);
end $$;

comment on function public.my_help_request(uuid) is
  'One support request and its public messages, for someone who may see it (else null). '
  'Internal notes never leave Rapid Rise.';

revoke execute on function public.my_help_request(uuid) from public, anon;
grant execute on function public.my_help_request(uuid) to authenticated;

-- == Reply ========================================================================
create or replace function public.reply_to_help_request(p_ticket uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := nullif(btrim(coalesce(p_body, '')), '');
  v_status support_ticket_status;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if v_body is null then
    raise exception 'support-need-message' using errcode = '22023';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'support-message-long' using errcode = '22023';
  end if;
  if not app.support_customer_can_see(p_ticket) then
    raise exception 'This is not a request you can see.' using errcode = '42501';
  end if;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket for update;
  -- Closed is final: a new question is a new request. Resolved reopens on a reply.
  if v_status = 'closed' then
    raise exception 'support-closed' using errcode = '22023';
  end if;

  perform app.support_take_message_slot();

  insert into public.support_ticket_messages (ticket_id, author_id, author_kind, visibility, channel, body)
  values (p_ticket, v_uid, 'customer', 'public', 'in_app', v_body)
  returning id into v_id;

  update public.support_tickets
     set status = 'open',
         resolved_at = null,
         resolved_by = null,
         resolution = null,
         last_customer_at = clock_timestamp(),
         due_at = app.support_due_at(now()),
         updated_at = now()
   where id = p_ticket;

  perform app.notify_rr_support(p_ticket, 'support_customer_reply');
  return v_id;
end $$;

comment on function public.reply_to_help_request(uuid, text) is
  'The customer (or their owner or manager) answers Rapid Rise on a request they may see. Reopens '
  'a resolved request, refuses a closed one, sets the next answer-by time and alerts Rapid Rise.';

revoke execute on function public.reply_to_help_request(uuid, text) from public, anon;
grant execute on function public.reply_to_help_request(uuid, text) to authenticated;
