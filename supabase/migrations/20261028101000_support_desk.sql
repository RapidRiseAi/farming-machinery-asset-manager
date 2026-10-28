-- 20261028101000_support_desk.sql
-- Rapid Rise working the support queue: see it, answer, note, assign, resolve, and open a
-- case for a customer who phoned, emailed or sent a WhatsApp.
--
-- Founder default (2026-10-28): the Fleet Wise admin is the system of record. Cases are
-- worked HERE, not in an outside dashboard; SUPPORT_WEBHOOK_URL stays optional.
--
-- Every function starts with app.is_rr_support() (today: a real Rapid Rise admin with the
-- second factor given this session) and refuses with 42501 otherwise. They are granted to
-- `authenticated` and called with the admin's own session, never the service key, so
-- auth.uid() names who answered, assigned or resolved.

-- What is due is app.support_next_due (20261028100950).

-- == The queue ===================================================================
-- p_status: active (open and waiting), unanswered (no first answer yet), overdue, waiting,
--           resolved (resolved and closed), all.
-- p_assignee: null for everyone, 'me', 'none', or a staff member's id.
create or replace function public.support_queue(
  p_status       text    default 'active',
  p_kind         text    default null,
  p_assignee     text    default null,
  p_include_test boolean default false,
  p_farm         uuid    default null
)
returns table (
  id                    uuid,
  kind                  text,
  status                text,
  subject               text,
  farm_id               uuid,
  farm_name             text,
  workshop_id           uuid,
  workshop_name         text,
  asked_by              uuid,
  asked_by_name         text,
  channel               text,
  assigned_to           uuid,
  assigned_name         text,
  opened_at             timestamptz,
  next_due              timestamptz,
  first_response_due_at timestamptz,
  first_response_at     timestamptz,
  last_customer_at      timestamptz,
  last_staff_at         timestamptz,
  needs_reply           boolean,
  is_test               boolean,
  external_ref          text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  return query
  with q as (
    select t.*,
           app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                t.first_response_at, t.last_customer_at, t.last_staff_at) as nd
      from public.support_tickets t
     where (p_include_test or not t.is_test)
       and (p_farm is null or t.farm_id = p_farm)
       and (p_kind is null or t.kind::text = p_kind)
       and (p_assignee is null
            or (p_assignee = 'me' and t.assigned_to = auth.uid())
            or (p_assignee = 'none' and t.assigned_to is null)
            or (p_assignee ~ '^[0-9a-fA-F-]{36}$' and t.assigned_to::text = lower(p_assignee)))
  )
  select q.id, q.kind::text, q.status::text, q.subject, q.farm_id, f.name, q.workshop_id, w.name,
         q.asked_by, u.name, q.channel, q.assigned_to, a.name, q.opened_at, q.nd,
         q.first_response_due_at, q.first_response_at, q.last_customer_at, q.last_staff_at,
         q.nd is not null, q.is_test, q.external_ref
    from q
    left join public.farms f on f.id = q.farm_id
    left join public.workshops w on w.id = q.workshop_id
    left join public.users u on u.id = q.asked_by
    left join public.users a on a.id = q.assigned_to
   where case coalesce(p_status, 'active')
           when 'active' then q.status in ('open', 'waiting')
           when 'unanswered' then q.status in ('open', 'waiting') and q.first_response_at is null
                                  and q.kind in ('help_request', 'privacy_request', 'export_request')
           when 'overdue' then q.nd is not null and q.nd < now()
           when 'waiting' then q.status = 'waiting'
           when 'resolved' then q.status in ('resolved', 'closed')
           else true
         end
   order by (q.status in ('open', 'waiting')) desc, q.nd asc nulls last, q.opened_at desc
   limit 300;
end $$;

comment on function public.support_queue(text, text, text, boolean, uuid) is
  'The support queue for Rapid Rise, with who asked, who has it and what is due. Real cases '
  'only unless p_include_test.';

-- == One case ====================================================================
create or replace function public.support_ticket(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind::text, 'status', t.status::text, 'subject', t.subject,
    'channel', t.channel, 'is_test', t.is_test, 'external_ref', t.external_ref,
    'opened_at', t.opened_at, 'due_at', t.due_at,
    'first_response_due_at', t.first_response_due_at, 'first_response_at', t.first_response_at,
    'last_customer_at', t.last_customer_at, 'last_staff_at', t.last_staff_at,
    'next_due', app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                     t.first_response_at, t.last_customer_at, t.last_staff_at),
    'resolved_at', t.resolved_at, 'resolution', t.resolution,
    'resolved_by_name', (select r.name from public.users r where r.id = t.resolved_by),
    'context', t.evidence->'context',
    'evidence', t.evidence,
    'farm', (select jsonb_build_object('id', f.id, 'name', f.name, 'is_test', f.is_test,
                                       'plan', f.plan, 'status', f.status, 'billing_email', f.billing_email)
               from public.farms f where f.id = t.farm_id),
    'workshop', (select jsonb_build_object('id', w.id, 'name', w.name, 'is_test', w.is_test)
                   from public.workshops w where w.id = t.workshop_id),
    'asker', (select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'phone', u.phone,
                                        'role', u.role::text, 'language', u.language::text, 'active', u.active)
                from public.users u where u.id = t.asked_by),
    'assignee', (select jsonb_build_object('id', a.id, 'name', a.name)
                   from public.users a where a.id = t.assigned_to),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'author_kind', m.author_kind, 'visibility', m.visibility,
               'channel', m.channel, 'author_name', au.name, 'body', m.body,
               'created_at', m.created_at, 'emailed_at', m.emailed_at, 'email_error', m.email_error)
               order by m.created_at, m.id)
        from public.support_ticket_messages m
        left join public.users au on au.id = m.author_id
       where m.ticket_id = t.id), '[]'::jsonb)
  ) into v
  from public.support_tickets t
  where t.id = p_ticket;
  return v;
end $$;

-- == Answer ======================================================================
-- A public reply: the customer sees it, gets an in-app alert, and the app emails them with
-- the facts this returns. The first public reply is the first response. A case nobody has
-- taken yet becomes the replier's.
create or replace function public.support_reply(
  p_ticket uuid, p_body text, p_status text default 'waiting'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_t    public.support_tickets%rowtype;
  v_id   uuid;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if v_body is null then
    raise exception 'support-need-message' using errcode = '22023';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'support-message-long' using errcode = '22023';
  end if;
  if coalesce(p_status, '') not in ('open', 'waiting') then
    raise exception 'support-status-invalid' using errcode = '22023';
  end if;
  select * into v_t from public.support_tickets t where t.id = p_ticket for update;
  if not found then
    raise exception 'not-found' using errcode = '22023';
  end if;
  if v_t.kind not in ('help_request', 'privacy_request', 'export_request') then
    raise exception 'support-no-customer' using errcode = '22023';
  end if;

  insert into public.support_ticket_messages (ticket_id, author_id, author_kind, visibility, channel, body)
  values (p_ticket, auth.uid(), 'staff', 'public', 'in_app', v_body)
  returning id into v_id;

  update public.support_tickets
     set status = p_status::support_ticket_status,
         resolved_at = null, resolved_by = null, resolution = null,
         first_response_at = coalesce(first_response_at, clock_timestamp()),
         last_staff_at = clock_timestamp(),
         assigned_to = coalesce(assigned_to, auth.uid()),
         updated_at = now()
   where id = p_ticket;

  perform app.notify_support_customer(p_ticket, 'support_reply');

  return jsonb_build_object(
    'message_id', v_id,
    'ticket_id', p_ticket,
    'subject', v_t.subject,
    'farm_id', v_t.farm_id,
    'workshop_id', v_t.workshop_id,
    'is_test', v_t.is_test,
    'customer', (select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email,
                                           'language', u.language::text)
                   from public.users u
                  where u.id = v_t.asked_by and u.active and u.deleted_at is null));
end $$;

-- == Note, or a conversation held elsewhere =====================================
-- Internal: the customer never sees it. With a channel other than in_app it records a call,
-- a WhatsApp, an email or a visit with the customer, which counts as an answer.
create or replace function public.support_add_note(
  p_ticket uuid, p_body text, p_channel text default 'in_app'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body    text := nullif(btrim(coalesce(p_body, '')), '');
  v_channel text := coalesce(nullif(btrim(coalesce(p_channel, '')), ''), 'in_app');
  v_id      uuid;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if v_body is null then
    raise exception 'support-need-message' using errcode = '22023';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'support-message-long' using errcode = '22023';
  end if;
  if v_channel not in ('in_app', 'phone', 'whatsapp', 'email', 'in_person') then
    raise exception 'support-channel-invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.support_tickets t where t.id = p_ticket) then
    raise exception 'not-found' using errcode = '22023';
  end if;

  insert into public.support_ticket_messages (ticket_id, author_id, author_kind, visibility, channel, body)
  values (p_ticket, auth.uid(), 'staff', 'internal', v_channel, v_body)
  returning id into v_id;

  if v_channel <> 'in_app' then
    update public.support_tickets
       set first_response_at = coalesce(first_response_at, clock_timestamp()),
           last_staff_at = clock_timestamp(),
           updated_at = now()
     where id = p_ticket;
  end if;
  return v_id;
end $$;

-- == Status ======================================================================
-- Resolving or closing needs a resolution in words: "resolved" with no reason reads as
-- handled and says nothing about how (Rapid Rise only; customers are not shown it).
create or replace function public.support_set_status(
  p_ticket uuid, p_status text, p_resolution text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res text := nullif(btrim(coalesce(p_resolution, '')), '');
  v_done boolean := coalesce(p_status, '') in ('resolved', 'closed');
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if coalesce(p_status, '') not in ('open', 'waiting', 'resolved', 'closed') then
    raise exception 'support-status-invalid' using errcode = '22023';
  end if;
  if v_done and v_res is null then
    raise exception 'support-need-resolution' using errcode = '22023';
  end if;
  if v_res is not null and char_length(v_res) > 2000 then
    raise exception 'support-message-long' using errcode = '22023';
  end if;
  update public.support_tickets
     set status = p_status::support_ticket_status,
         resolved_at = case when v_done then coalesce(resolved_at, now()) end,
         resolved_by = case when v_done then auth.uid() end,
         resolution = case when v_done then v_res end,
         updated_at = now()
   where id = p_ticket;
  if not found then
    raise exception 'not-found' using errcode = '22023';
  end if;
end $$;

-- == Who has it ==================================================================
create or replace function public.support_staff()
returns table (id uuid, name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  return query
    select u.id, u.name from public.users u
     where u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test
     order by u.name;
end $$;

create or replace function public.support_assign(p_ticket uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  -- Only a real, active member of the team: never a test account, never a customer.
  if p_user is not null and not exists (
       select 1 from public.users u
        where u.id = p_user and u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test) then
    raise exception 'support-assignee-invalid' using errcode = '22023';
  end if;
  update public.support_tickets set assigned_to = p_user, updated_at = now() where id = p_ticket;
  if not found then
    raise exception 'not-found' using errcode = '22023';
  end if;
end $$;

-- == A case for a customer who reached us another way ===========================
-- Logged from a call, a WhatsApp, an email or a visit, for one person on the farm, who then
-- sees it under "What you have asked". The conversation that prompted it is the first
-- answer; the summary is a public message so the customer can read what was agreed.
create or replace function public.support_open_for_customer(
  p_farm uuid, p_user uuid, p_subject text, p_message text, p_channel text,
  p_kind text default 'help_request'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_kind    text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'help_request');
  v_due     timestamptz;
  v_name    text;
  v_plan    text;
  v_id      uuid;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if v_subject is null or v_message is null then
    raise exception 'support-need-message' using errcode = '22023';
  end if;
  if char_length(v_message) > 4000 then
    raise exception 'support-message-long' using errcode = '22023';
  end if;
  if coalesce(p_channel, '') not in ('phone', 'whatsapp', 'email', 'in_person') then
    raise exception 'support-channel-invalid' using errcode = '22023';
  end if;
  if v_kind not in ('help_request', 'privacy_request', 'export_request') then
    raise exception 'support-kind-invalid' using errcode = '22023';
  end if;
  select f.name, f.plan::text into v_name, v_plan from public.farms f where f.id = p_farm and f.deleted_at is null;
  if not found then
    raise exception 'not-found' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.users u
        where u.id = p_user and u.active and u.deleted_at is null
          and (u.farm_id = p_farm
               or exists (select 1 from public.user_farm_memberships m
                           where m.user_id = u.id and m.farm_id = p_farm and m.active and m.deleted_at is null))) then
    raise exception 'support-person-invalid' using errcode = '22023';
  end if;

  v_due := app.support_due_at(now());
  insert into public.support_tickets (
    kind, status, subject, farm_id, asked_by, channel, assigned_to,
    due_at, first_response_due_at, first_response_at, last_staff_at, evidence
  ) values (
    v_kind::support_ticket_kind, 'open', left(v_subject, 200), p_farm, p_user, p_channel, auth.uid(),
    v_due, v_due, clock_timestamp(), clock_timestamp(),
    jsonb_build_object('source', 'staff', 'opened_by', auth.uid(),
                       'farm', jsonb_build_object('id', p_farm, 'name', v_name, 'plan', v_plan))
  )
  returning id into v_id;

  insert into public.support_ticket_messages (ticket_id, author_id, author_kind, visibility, channel, body)
  values (v_id, auth.uid(), 'staff', 'public', p_channel, v_message);
  return v_id;
end $$;

-- == The nav badge and the overview ============================================
-- Real cases waiting on Rapid Rise. Zero, not an error, for anyone else: the app shell asks
-- on every page an admin opens.
create or replace function public.support_badge() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select case when app.is_rr_support() then (
    select count(*)::integer from public.support_tickets t
     where not t.is_test
       and t.status in ('open', 'waiting')
       and app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                t.first_response_at, t.last_customer_at, t.last_staff_at) is not null
  ) else 0 end;
$$;

create or replace function public.support_overview(p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz  text;
  v_end timestamptz;
  v     jsonb;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  select s.timezone into v_tz from public.support_settings s where s.singleton;
  v_tz := coalesce(v_tz, 'Africa/Johannesburg');
  v_end := (((now() at time zone v_tz)::date + 1)::timestamp) at time zone v_tz;

  with q as (
    select t.*,
           app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                t.first_response_at, t.last_customer_at, t.last_staff_at) as nd,
           t.kind in ('help_request', 'privacy_request', 'export_request') as customer
      from public.support_tickets t
     where (p_include_test or not t.is_test)
  )
  select jsonb_build_object(
    'new',       count(*) filter (where q.customer and q.status = 'open' and q.first_response_at is null),
    'due_today', count(*) filter (where q.nd >= now() and q.nd < v_end),
    'overdue',   count(*) filter (where q.nd < now()),
    'waiting',   count(*) filter (where q.customer and q.status = 'waiting'),
    'disputes',  count(*) filter (where q.kind = 'dispute' and q.status in ('open', 'waiting')),
    'dispute_next_due', min(q.due_at) filter (where q.kind = 'dispute' and q.status in ('open', 'waiting')),
    'privacy',   count(*) filter (where q.kind = 'privacy_request' and q.status in ('open', 'waiting')),
    'exports',   count(*) filter (where q.kind = 'export_request' and q.status in ('open', 'waiting')),
    'attention', coalesce((
      select jsonb_agg(x.item order by x.nd)
        from (select q2.nd,
                     jsonb_build_object('id', q2.id, 'subject', q2.subject, 'kind', q2.kind::text,
                                        'farm_name', f.name, 'workshop_name', w.name,
                                        'next_due', q2.nd, 'overdue', q2.nd < now(),
                                        'unanswered', q2.first_response_at is null,
                                        'is_test', q2.is_test) as item
                from q q2
                left join public.farms f on f.id = q2.farm_id
                left join public.workshops w on w.id = q2.workshop_id
               where q2.nd is not null
               order by q2.nd
               limit 15) x), '[]'::jsonb)
  ) into v
  from q;
  return v;
end $$;

-- == The reply email's outcome =================================================
create or replace function public.support_mark_emailed(p_message uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  update public.support_ticket_messages
     set emailed_at = case when p_error is null then now() end,
         email_error = left(p_error, 300)
   where id = p_message and author_kind = 'staff';
end $$;

revoke execute on function public.support_queue(text, text, text, boolean, uuid) from public, anon;
revoke execute on function public.support_ticket(uuid) from public, anon;
revoke execute on function public.support_reply(uuid, text, text) from public, anon;
revoke execute on function public.support_add_note(uuid, text, text) from public, anon;
revoke execute on function public.support_set_status(uuid, text, text) from public, anon;
revoke execute on function public.support_staff() from public, anon;
revoke execute on function public.support_assign(uuid, uuid) from public, anon;
revoke execute on function public.support_open_for_customer(uuid, uuid, text, text, text, text) from public, anon;
revoke execute on function public.support_badge() from public, anon;
revoke execute on function public.support_overview(boolean) from public, anon;
revoke execute on function public.support_mark_emailed(uuid, text) from public, anon;

grant execute on function public.support_queue(text, text, text, boolean, uuid) to authenticated;
grant execute on function public.support_ticket(uuid) to authenticated;
grant execute on function public.support_reply(uuid, text, text) to authenticated;
grant execute on function public.support_add_note(uuid, text, text) to authenticated;
grant execute on function public.support_set_status(uuid, text, text) to authenticated;
grant execute on function public.support_staff() to authenticated;
grant execute on function public.support_assign(uuid, uuid) to authenticated;
grant execute on function public.support_open_for_customer(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.support_badge() to authenticated;
grant execute on function public.support_overview(boolean) to authenticated;
grant execute on function public.support_mark_emailed(uuid, text) to authenticated;
