-- Asking for help from inside the product.
--
-- Two things matter here and they pull against each other. A farmer must be able to open a
-- case and see the answer; `support_tickets` also holds DISPUTES, whose evidence is a
-- billing dossier assembled by the most sensitive function in this schema. So the whole
-- point of these assertions is that opening the first door did not open the second.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _hr_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _hr_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('be000000-0000-4000-8000-000000000001', 'Help Farm', 'complete', 'active'),
  ('be000000-0000-4000-8000-000000000002', 'Other Help Farm', 'essential', 'active');

insert into auth.users (id, email) values
  ('be100000-0000-4000-8000-000000000001', 'help-owner@example.test'),
  ('be100000-0000-4000-8000-000000000002', 'help-operator@example.test'),
  ('be100000-0000-4000-8000-000000000003', 'help-neighbour@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('be100000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-000000000001',
   'owner', 'Help Owner', 'help-owner@example.test'),
  ('be100000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-000000000001',
   'operator', 'Help Operator', 'help-operator@example.test'),
  ('be100000-0000-4000-8000-000000000003', 'be000000-0000-4000-8000-000000000002',
   'owner', 'Neighbour', 'help-neighbour@example.test');

-- A dispute on the same farm, with the kind of evidence the billing builder produces. It
-- exists so that "can a farmer read their own cases" has something dangerous to fail on.
insert into public.support_tickets (id, kind, status, farm_id, subject, evidence) values
  ('be300000-0000-4000-8000-000000000001', 'dispute', 'open',
   'be000000-0000-4000-8000-000000000001', 'Chargeback on FW-2026-0004',
   '{"card": {"last4": "4242"}, "attempts": [{"ref": "psk_1", "status": "failed"}]}'::jsonb);

-- == (a) A farmer opens a case, and it speaks for them =======================
set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000001');
do $$
declare v_id uuid; s public.support_tickets%rowtype;
begin
  v_id := public.open_help_request(
    '  The QR sticker will not scan  ',
    '  It worked last week on the Massey and now nothing happens.  ',
    '{"path": "/machines/abc", "app_version": "2026.09.21", "locale": "af", "secret": "do not keep me"}'::jsonb
  );
  if v_id is null then
    raise exception 'HELP FAIL [a]: opening a help request returned nothing';
  end if;

  -- Read back as the suite's own role, because the farmer deliberately cannot read this
  -- table directly. What is being checked is what was WRITTEN.
  perform set_config('request.jwt.claims', '', true);
end $$;
reset role;

do $$
declare s public.support_tickets%rowtype;
begin
  select * into s from public.support_tickets
   where kind = 'help_request' and farm_id = 'be000000-0000-4000-8000-000000000001';

  if s.subject <> 'The QR sticker will not scan' then
    raise exception 'HELP FAIL [a]: the subject was stored as "%"', s.subject;
  end if;
  if s.evidence->>'message' not like '%worked last week%' then
    raise exception 'HELP FAIL [a]: the message did not reach the case';
  end if;
  -- The farm comes from auth.uid(), never from the caller.
  if s.farm_id <> 'be000000-0000-4000-8000-000000000001' then
    raise exception 'HELP FAIL [a]: the case was filed against farm %', s.farm_id;
  end if;
  if s.evidence->'asked_by'->>'email' <> 'help-owner@example.test' then
    raise exception 'HELP FAIL [a]: the case does not say who asked';
  end if;
  if s.evidence->'farm'->>'plan' <> 'complete' then
    raise exception 'HELP FAIL [a]: the plan is missing, so support has to go and look it up';
  end if;
  -- Context is allow-listed: the three keys we asked for, and nothing else a form posted.
  if s.evidence->'context'->>'path' <> '/machines/abc' then
    raise exception 'HELP FAIL [a]: the screen they were on was not kept';
  end if;
  if s.evidence->'context' ? 'secret' then
    raise exception 'HELP FAIL [a]: an unexpected key was copied into something a person reads';
  end if;
  -- Somebody is waiting for an answer, so the escalation clock has something to measure.
  if s.due_at is null then
    raise exception 'HELP FAIL [a]: a help request carries no due date';
  end if;
  -- And it carries NO billing evidence.
  if s.evidence ? 'card' or s.evidence ? 'attempts' or s.evidence ? 'invoice' then
    raise exception 'HELP FAIL [a]: a billing dossier was attached to a question about a QR sticker';
  end if;
end $$;

-- == (b) A blank question is not a question ==================================
set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000001');
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    perform public.open_help_request('   ', 'Body without a subject');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'HELP FAIL [b]: a case with no subject was opened';
  end if;

  v_failed := false;
  begin
    perform public.open_help_request('Subject without a body', '');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'HELP FAIL [b]: a case with no message was opened';
  end if;
end $$;
reset role;

-- == (c) The queue is read by a person, so it has a ceiling ==================
set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000001');
do $$
declare v_failed boolean := false; n integer;
begin
  -- One is already open from (a). Four more reaches the limit.
  for i in 1..4 loop
    perform public.open_help_request('Question ' || i, 'Body ' || i);
  end loop;
  begin
    perform public.open_help_request('One too many', 'Body');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'HELP FAIL [c]: a sixth open question was accepted';
  end if;

  -- Their own list shows all five, newest first, and no evidence column at all.
  select count(*) into n from public.my_help_requests();
  if n <> 5 then
    raise exception 'HELP FAIL [c]: the farmer sees % of their own 5 questions', n;
  end if;
end $$;
reset role;

-- Resolving one frees a slot: somebody with a genuine run of problems is never locked out.
update public.support_tickets set status = 'resolved', resolved_at = now()
 where kind = 'help_request' and subject = 'Question 1';

set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000001');
do $$
begin
  perform public.open_help_request('After a resolution', 'There is room again');
end $$;
reset role;

-- == (d) The dispute stays shut ==============================================
set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000001');
do $$
declare n integer;
begin
  -- The farmer's own list is help requests only. The dispute on the same farm is not on it.
  if exists (select 1 from public.my_help_requests()
              where subject = 'Chargeback on FW-2026-0004') then
    raise exception 'HELP FAIL [d]: a billing dispute appeared in the farmer''s own list';
  end if;

  -- And the table itself is still rr_admin only, so there is no second way round.
  select count(*) into n from public.support_tickets;
  if n <> 0 then
    raise exception 'HELP FAIL [d]: a farm owner can read % rows of support_tickets directly', n;
  end if;
end $$;
reset role;

-- == (e) An operator may ask, and sees only their own farm ===================
--
-- The ceiling in (c) is per FARM, not per person: the queue it protects is one queue, read
-- by one person, and five open questions from one farm is already more than any real farm
-- needs. So everything above is cleared before an operator tries, or this section would
-- fail on the limit rather than on the thing it is about. That the clearing is necessary
-- IS the ceiling working.
update public.support_tickets set status = 'resolved', resolved_at = now()
 where kind = 'help_request' and status in ('open', 'waiting');

set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000002');
do $$
declare v_id uuid;
begin
  -- Anybody who can sign in can ask for help. A driver stuck on a screen is exactly who
  -- this is for, and making them find the owner first is how the question never gets asked.
  v_id := public.open_help_request('The checklist will not submit', 'It spins and stops.');
  if v_id is null then
    raise exception 'HELP FAIL [e]: an operator could not ask for help';
  end if;
end $$;
reset role;

set role authenticated;
select _hr_login('be100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.my_help_requests();
  if n <> 0 then
    raise exception 'HELP FAIL [e]: a neighbouring farm sees % of these questions', n;
  end if;
end $$;
reset role;

-- == (f) Grants ==============================================================
do $$
begin
  if has_function_privilege('anon', 'public.open_help_request(text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.my_help_requests()', 'EXECUTE') then
    raise exception 'HELP FAIL [f]: anon may open or read help requests';
  end if;
  if not has_function_privilege('authenticated', 'public.open_help_request(text,text,jsonb)', 'EXECUTE') then
    raise exception 'HELP FAIL [f]: a signed-in farmer cannot ask for help';
  end if;
end $$;

rollback;
