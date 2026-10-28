-- The support desk (20261028100000 to 20261028101200).
--
-- What must hold:
--   (a) answer-by times follow the support calendar: hours, the 16:00 cutoff, weekends and
--       public holidays, in South African time whatever the server's clock;
--   (b) a customer sees their own requests, an owner or manager also their farm's (never a
--       privacy request, never a contractor's), and nobody ever another farm's;
--   (c) asking: the farm is checked, contractors may ask about a linked farm only, exports
--       are for owners and managers, and the rate limit holds;
--   (d) staff functions refuse a farm owner, a test Rapid Rise account and Rapid Rise without
--       the second factor; the real admin works the queue;
--   (e) a staff reply reaches the customer, an internal note never does; alerts go to the
--       real admin only, filed with no farm; a test case alerts nobody;
--   (f) resolving needs words, assigning needs a real admin;
--   (g) support visits need a reason and only the farm's owner sees them;
--   (h) Rapid Rise can invite an owner; nobody else can;
--   (i) grants: anon executes none of it, and the engines are reachable only through it.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

-- Who is acting. aal2 is the second factor given this session (20261014100000). Created
-- inside this transaction and rolled back with it, like help_requests.sql's helper.
create function public._sd_as(p_user text, p_aal text default 'aal1') returns void
language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    case when p_user = '' then ''
         else pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end,
    true);
$$;
grant execute on function public._sd_as(text, text) to public;

-- == Fixtures =================================================================
-- Farm A (owner, manager, operator, mechanic), farm B (its own owner), a test farm T, a
-- contractor W linked to A, a real admin, a test admin.
insert into public.farms (id, name, plan, status, is_test) values
  ('5d000000-0000-4000-8000-00000000000a', 'Desk Farm A', 'complete', 'active', false),
  ('5d000000-0000-4000-8000-00000000000b', 'Desk Farm B', 'essential', 'active', false),
  ('5d000000-0000-4000-8000-00000000000c', 'Desk Farm C', 'essential', 'active', false),
  ('5d000000-0000-4000-8000-0000000000fe', 'Desk Test Farm', 'complete', 'active', true);
insert into public.workshops (id, name, is_test) values
  ('5d000000-0000-4000-8000-0000000000aa', 'Desk Contractor', false),
  ('5d000000-0000-4000-8000-0000000000ab', 'Unlinked Contractor', false);
insert into public.workshop_links (workshop_id, farm_id, status) values
  ('5d000000-0000-4000-8000-0000000000aa', '5d000000-0000-4000-8000-00000000000a', 'active');

insert into auth.users (id, email, last_sign_in_at) values
  ('5d100000-0000-4000-8000-000000000001', 'desk.owner.a@example.test', now() - interval '1 day'),
  ('5d100000-0000-4000-8000-000000000002', 'desk.manager.a@example.test', null),
  ('5d100000-0000-4000-8000-000000000003', 'desk.operator.a@example.test', null),
  ('5d100000-0000-4000-8000-000000000004', 'desk.mechanic.a@example.test', null),
  ('5d100000-0000-4000-8000-000000000005', 'desk.owner.b@example.test', null),
  ('5d100000-0000-4000-8000-000000000006', 'desk.fitter@example.test', null),
  ('5d100000-0000-4000-8000-000000000007', 'desk.admin@example.test', null),
  ('5d100000-0000-4000-8000-000000000008', 'desk.test.admin@example.test', null),
  ('5d100000-0000-4000-8000-000000000009', 'desk.test.owner@example.test', null),
  ('5d100000-0000-4000-8000-00000000000a', 'desk.chatty@example.test', null),
  ('5d100000-0000-4000-8000-00000000000b', 'desk.fitter.two@example.test', null);
insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('5d100000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-00000000000a', null, 'owner',    'Owner A',    'desk.owner.a@example.test'),
  ('5d100000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-00000000000a', null, 'manager',  'Manager A',  'desk.manager.a@example.test'),
  ('5d100000-0000-4000-8000-000000000003', '5d000000-0000-4000-8000-00000000000a', null, 'operator', 'Operator A', 'desk.operator.a@example.test'),
  ('5d100000-0000-4000-8000-000000000004', '5d000000-0000-4000-8000-00000000000a', null, 'mechanic', 'Mechanic A', 'desk.mechanic.a@example.test'),
  ('5d100000-0000-4000-8000-000000000005', '5d000000-0000-4000-8000-00000000000b', null, 'owner',    'Owner B',    'desk.owner.b@example.test'),
  ('5d100000-0000-4000-8000-000000000006', null, '5d000000-0000-4000-8000-0000000000aa', 'workshop', 'Fitter',     'desk.fitter@example.test'),
  ('5d100000-0000-4000-8000-000000000007', null, null,                                   'rr_admin', 'Desk Admin', 'desk.admin@example.test'),
  ('5d100000-0000-4000-8000-000000000009', '5d000000-0000-4000-8000-0000000000fe', null, 'owner',    'Test Owner', 'desk.test.owner@example.test'),
  ('5d100000-0000-4000-8000-00000000000a', '5d000000-0000-4000-8000-00000000000b', null, 'operator', 'Chatty B',   'desk.chatty@example.test'),
  ('5d100000-0000-4000-8000-00000000000b', null, '5d000000-0000-4000-8000-0000000000ab', 'workshop', 'Fitter Two', 'desk.fitter.two@example.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, is_test) values
  ('5d100000-0000-4000-8000-000000000008', null, null, 'rr_admin', 'Test Admin', 'desk.test.admin@example.test', true);
-- The operator also works on farm C, through a membership.
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('5d100000-0000-4000-8000-000000000003', '5d000000-0000-4000-8000-00000000000c', 'operator', true);

-- == (a) Answer-by times ======================================================
-- All in SAST (UTC+2, no daylight saving). The server's own zone must not matter.
set local timezone = 'UTC';
do $$
declare
  f text := 'YYYY-MM-DD HH24:MI';
  got text;
  cases text[][] := array[
    -- received (SAST)        due (SAST)          why
    array['2026-10-30 10:00', '2026-10-30 17:00', 'Friday morning: 17:00 the same day'],
    array['2026-10-30 09:00', '2026-10-30 17:00', 'exactly opening: the same day'],
    array['2026-10-30 15:59', '2026-10-30 17:00', 'just before the cutoff: the same day'],
    array['2026-10-30 16:00', '2026-11-02 12:00', 'the cutoff itself: Monday noon'],
    array['2026-10-30 16:30', '2026-11-02 12:00', 'Friday after the cutoff: Monday noon'],
    array['2026-10-31 11:00', '2026-11-02 12:00', 'Saturday: Monday noon'],
    array['2026-11-01 23:30', '2026-11-02 12:00', 'Sunday night: Monday noon'],
    array['2026-11-02 08:00', '2026-11-02 12:00', 'Monday before opening: noon that day'],
    array['2026-11-02 01:00', '2026-11-02 12:00', 'Monday 01:00 SAST is still Sunday in UTC'],
    array['2026-12-16 10:00', '2026-12-17 12:00', 'Day of Reconciliation: the next day noon'],
    array['2026-12-24 16:30', '2026-12-28 12:00', 'Christmas Eve late: past Christmas, Goodwill and the weekend'],
    array['2026-04-02 16:01', '2026-04-07 12:00', 'before Easter: past Good Friday, the weekend and Family Day'],
    array['2026-08-07 17:30', '2026-08-11 12:00', 'Women''s Day on a Sunday: the Monday is off too'],
    array['2027-12-24 12:00', '2027-12-24 17:00', 'Christmas Eve 2027 is a working Friday'],
    array['2027-12-24 16:15', '2027-12-28 12:00', '2027: Christmas Saturday, Goodwill Sunday and Monday observed']
  ];
  i int;
begin
  for i in 1 .. array_length(cases, 1) loop
    got := to_char(app.support_due_at((cases[i][1] || ' Africa/Johannesburg')::timestamptz) at time zone 'Africa/Johannesburg', f);
    if got <> cases[i][2] then
      raise exception 'DESK FAIL [a]: % (received %): due % expected %', cases[i][3], cases[i][1], got, cases[i][2];
    end if;
  end loop;
end $$;

-- The calendar is data: a new holiday and a later cutoff change the answer, no deploy.
update public.support_settings set same_day_cutoff = '16:30' where singleton;
insert into public.support_holidays (day, name) values ('2026-11-03', 'Declared day');
do $$ declare got text; begin
  got := to_char(app.support_due_at('2026-10-30 16:15 Africa/Johannesburg'::timestamptz) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI');
  if got <> '2026-10-30 17:00' then raise exception 'DESK FAIL [a]: a 16:30 cutoff did not take: %', got; end if;
  got := to_char(app.support_due_at('2026-11-02 16:45 Africa/Johannesburg'::timestamptz) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI');
  if got <> '2026-11-04 12:00' then raise exception 'DESK FAIL [a]: a declared holiday was not skipped: %', got; end if;
end $$;
update public.support_settings set same_day_cutoff = '16:00' where singleton;
delete from public.support_holidays where day = '2026-11-03';
reset timezone;

-- == (b), (c) Asking and seeing ================================================
set local role authenticated;
do $$
declare
  v_op uuid; v_priv uuid; v_mech uuid; v_fitter uuid; v_c uuid; v_test uuid; v_n int; v jsonb;
begin
  -- The operator asks on their primary farm.
  perform public._sd_as('5d100000-0000-4000-8000-000000000003');
  v_op := public.open_help_request('The checklist will not submit', 'It spins and stops.',
            '{"path": "/checklists", "secret": "drop me"}'::jsonb);
  v_priv := public.open_help_request('Delete my details', 'Please remove my phone number.', '{}'::jsonb, null, 'privacy_request');
  -- And on farm C, where they are a member.
  v_c := public.open_help_request('On the other farm', 'A question there.', '{}'::jsonb, '5d000000-0000-4000-8000-00000000000c');
  -- Not on farm B.
  begin
    perform public.open_help_request('Sneaky', 'On a farm I am not on.', '{}'::jsonb, '5d000000-0000-4000-8000-00000000000b');
    raise exception 'DESK FAIL [c]: an operator filed a request on a farm they do not belong to';
  exception when insufficient_privilege then null; end;
  -- An export of the farm's data is for its owner or a manager.
  begin
    perform public.open_help_request('Export everything', 'All of it.', '{}'::jsonb, null, 'export_request');
    raise exception 'DESK FAIL [c]: an operator asked for a full export of the farm';
  exception when insufficient_privilege then null; end;
  begin
    perform public.open_help_request('Odd', 'Odd kind.', '{}'::jsonb, null, 'dispute');
    raise exception 'DESK FAIL [c]: a customer opened a dispute through the help form';
  exception when invalid_parameter_value then null; end;

  select count(*) into v_n from public.my_help_requests();
  if v_n <> 3 then raise exception 'DESK FAIL [b]: the operator sees % of their own 3 requests', v_n; end if;
  if (select count(*) from public.support_tickets) <> 0 then
    raise exception 'DESK FAIL [b]: a customer can read support_tickets directly';
  end if;
  if (select count(*) from public.support_ticket_messages) <> 0 then
    raise exception 'DESK FAIL [b]: a customer can read support_ticket_messages directly';
  end if;

  -- The mechanic asks too; they see only their own.
  perform public._sd_as('5d100000-0000-4000-8000-000000000004');
  v_mech := public.open_help_request('Grease gun', 'Which grease?');
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 1 then raise exception 'DESK FAIL [b]: a mechanic sees % requests, not just their own', v_n; end if;
  if public.my_help_request(v_op) is not null then
    raise exception 'DESK FAIL [b]: a mechanic opened the operator''s request';
  end if;

  -- The owner sees the farm's, but not the privacy request and not farm C's.
  perform public._sd_as('5d100000-0000-4000-8000-000000000001');
  select count(*) into v_n from public.my_help_requests();
  if v_n <> 0 then raise exception 'DESK FAIL [b]: with no farm chosen the owner sees % requests', v_n; end if;
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 2 then raise exception 'DESK FAIL [b]: the owner sees % of the farm''s 2 visible requests', v_n; end if;
  if exists (select 1 from public.my_help_requests('5d000000-0000-4000-8000-00000000000a') r where r.id = v_priv) then
    raise exception 'DESK FAIL [b]: the owner sees an employee''s privacy request';
  end if;
  if public.my_help_request(v_priv) is not null then
    raise exception 'DESK FAIL [b]: the owner opened an employee''s privacy request';
  end if;
  if public.my_help_request(v_op) is null then
    raise exception 'DESK FAIL [b]: the owner cannot open a request asked on their farm';
  end if;
  if public.my_help_request(v_c) is not null then
    raise exception 'DESK FAIL [b]: the owner of A opened a request about farm C';
  end if;
  -- The owner of A asks for the export.
  perform public.open_help_request('Full export', 'Everything for the auditors.', '{}'::jsonb, null, 'export_request');

  -- The manager sees the same as the owner.
  perform public._sd_as('5d100000-0000-4000-8000-000000000002');
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 3 then raise exception 'DESK FAIL [b]: the manager sees % of the farm''s 3 visible requests', v_n; end if;

  -- Another farm's owner sees none of it, even naming farm A.
  perform public._sd_as('5d100000-0000-4000-8000-000000000005');
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 0 then raise exception 'DESK FAIL [b]: farm B''s owner sees % of farm A''s requests', v_n; end if;
  if public.my_help_request(v_op) is not null then
    raise exception 'DESK FAIL [b]: farm B''s owner opened farm A''s request';
  end if;
  begin
    perform public.reply_to_help_request(v_op, 'Hijack');
    raise exception 'DESK FAIL [b]: farm B''s owner replied on farm A''s request';
  exception when insufficient_privilege then null; end;

  -- The contractor asks about the farm they are linked to, and about their own business.
  perform public._sd_as('5d100000-0000-4000-8000-000000000006');
  v_fitter := public.open_help_request('Quote layout', 'The quote is cut off.', '{}'::jsonb, '5d000000-0000-4000-8000-00000000000a');
  perform public.open_help_request('My own invoice', 'About my business.');
  begin
    perform public.open_help_request('Not linked', 'Farm B.', '{}'::jsonb, '5d000000-0000-4000-8000-00000000000b');
    raise exception 'DESK FAIL [c]: a contractor filed on a farm they are not linked to';
  exception when insufficient_privilege then null; end;
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 2 then raise exception 'DESK FAIL [b]: the contractor sees % requests, not their own 2', v_n; end if;

  -- The farm's owner does not see the contractor's question.
  perform public._sd_as('5d100000-0000-4000-8000-000000000001');
  if exists (select 1 from public.my_help_requests('5d000000-0000-4000-8000-00000000000a') r where r.id = v_fitter) then
    raise exception 'DESK FAIL [b]: the farm owner sees a contractor''s question';
  end if;

  -- An unlinked contractor sees nothing of anybody's.
  perform public._sd_as('5d100000-0000-4000-8000-00000000000b');
  select count(*) into v_n from public.my_help_requests('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 0 then raise exception 'DESK FAIL [b]: an unlinked contractor sees % requests', v_n; end if;

  -- The test farm's owner asks: a test case.
  perform public._sd_as('5d100000-0000-4000-8000-000000000009');
  v_test := public.open_help_request('Test question', 'From the click-through.');

  -- Rapid Rise does not use the customer form.
  perform public._sd_as('5d100000-0000-4000-8000-000000000007', 'aal2');
  begin
    perform public.open_help_request('Staff', 'From the desk.');
    raise exception 'DESK FAIL [c]: Rapid Rise opened a case through the customer form';
  exception when insufficient_privilege then null; end;

  perform public._sd_as('');
end $$;
reset role;

-- What was written: the question is a message, the evidence is small, the clock is set.
do $$
declare t public.support_tickets%rowtype;
begin
  select * into t from public.support_tickets where subject = 'The checklist will not submit';
  if t.asked_by <> '5d100000-0000-4000-8000-000000000003' or t.farm_id <> '5d000000-0000-4000-8000-00000000000a' then
    raise exception 'DESK FAIL [c]: the request was filed for % on %', t.asked_by, t.farm_id;
  end if;
  if t.first_response_due_at is null or t.due_at is null or t.last_customer_at is null then
    raise exception 'DESK FAIL [c]: the request carries no answer-by time';
  end if;
  if t.evidence ? 'message' or t.evidence->'asked_by' ? 'email' or t.evidence->'context' ? 'secret'
     or t.evidence ? 'card' or t.evidence ? 'owner' then
    raise exception 'DESK FAIL [c]: the evidence carries more than it should: %', t.evidence;
  end if;
  if not exists (select 1 from public.support_ticket_messages m
                  where m.ticket_id = t.id and m.author_kind = 'customer' and m.body = 'It spins and stops.') then
    raise exception 'DESK FAIL [c]: the question is not the first message';
  end if;
  if t.is_test then raise exception 'DESK FAIL [e]: a real farm''s request was marked test'; end if;
  if not (select is_test from public.support_tickets where subject = 'Test question') then
    raise exception 'DESK FAIL [e]: a test farm''s request was not marked test';
  end if;
  if (select workshop_id from public.support_tickets where subject = 'Quote layout') <> '5d000000-0000-4000-8000-0000000000aa' then
    raise exception 'DESK FAIL [c]: the contractor''s request does not name their business';
  end if;

  -- Alerts: the real admin once per real request, filed with no farm, the case id only.
  if exists (select 1 from public.notifications n where n.template = 'support_request_new'
              and n.user_id = '5d100000-0000-4000-8000-000000000008') then
    raise exception 'DESK FAIL [e]: a test admin was alerted';
  end if;
  if exists (select 1 from public.notifications n where n.template = 'support_request_new'
              and (n.farm_id is not null or n.payload - 'ticket_id' <> '{}'::jsonb)) then
    raise exception 'DESK FAIL [e]: a Rapid Rise alert was filed under a farm or carried more than the case id';
  end if;
  if exists (select 1 from public.notifications n
              where n.template = 'support_request_new'
                and n.payload->>'ticket_id' = (select id::text from public.support_tickets where subject = 'Test question')) then
    raise exception 'DESK FAIL [e]: a test case alerted Rapid Rise';
  end if;
  if (select count(*) from public.notifications n where n.template = 'support_request_new'
        and n.user_id = '5d100000-0000-4000-8000-000000000007') <> 7 then
    raise exception 'DESK FAIL [e]: the admin got % alerts for 7 real requests',
      (select count(*) from public.notifications n where n.template = 'support_request_new'
         and n.user_id = '5d100000-0000-4000-8000-000000000007');
  end if;
end $$;

-- == (c) The rate limit =========================================================
set local role authenticated;
do $$
declare v uuid; i int; v_hit boolean := false;
begin
  perform public._sd_as('5d100000-0000-4000-8000-00000000000a');
  v := public.open_help_request('Many words', 'First.');
  for i in 1 .. 11 loop
    perform public.reply_to_help_request(v, 'More ' || i);
  end loop;
  begin
    perform public.reply_to_help_request(v, 'One too many');
  exception when sqlstate '53400' then v_hit := true; end;
  if not v_hit then raise exception 'DESK FAIL [c]: a thirteenth message in fifteen minutes was accepted'; end if;
  perform public._sd_as('');
end $$;
reset role;

-- == (d) Staff functions refuse everybody but the real admin with two-step ======
set local role authenticated;
do $$
declare
  who text[] := array[
    '5d100000-0000-4000-8000-000000000001|aal2|a farm owner',
    '5d100000-0000-4000-8000-000000000006|aal2|a contractor',
    '5d100000-0000-4000-8000-000000000008|aal2|a test Rapid Rise account',
    '5d100000-0000-4000-8000-000000000007|aal1|Rapid Rise without the second factor'];
  w text; parts text[]; v_t uuid;
begin
  select id into v_t from public.support_tickets where subject = 'Grease gun';
  foreach w in array who loop
    parts := string_to_array(w, '|');
    perform public._sd_as(parts[1], parts[2]);
    begin perform * from public.support_queue(); raise exception 'DESK FAIL [d]: % read the queue', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_ticket(v_t); raise exception 'DESK FAIL [d]: % read a case', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_reply(v_t, 'x'); raise exception 'DESK FAIL [d]: % replied as Rapid Rise', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_add_note(v_t, 'x'); raise exception 'DESK FAIL [d]: % wrote a note', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_set_status(v_t, 'closed', 'x'); raise exception 'DESK FAIL [d]: % closed a case', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_assign(v_t, null); raise exception 'DESK FAIL [d]: % assigned a case', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform * from public.support_staff(); raise exception 'DESK FAIL [d]: % listed the staff', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_overview(); raise exception 'DESK FAIL [d]: % read the overview', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.admin_client('5d000000-0000-4000-8000-00000000000a'); raise exception 'DESK FAIL [d]: % read a client', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_open_for_customer('5d000000-0000-4000-8000-00000000000a', '5d100000-0000-4000-8000-000000000001', 's', 'm', 'phone');
      raise exception 'DESK FAIL [d]: % opened a case for a customer', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_visit_start('5d000000-0000-4000-8000-00000000000a', 'look'); raise exception 'DESK FAIL [d]: % entered support mode', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_update_settings('a@example.test', null, null, '09:00', '17:00', '16:00', '12:00', '1,2,3,4,5');
      raise exception 'DESK FAIL [d]: % changed the support settings', parts[3];
    exception when insufficient_privilege then null; end;
    begin perform public.support_holiday_set('2026-11-30', 'x'); raise exception 'DESK FAIL [d]: % added a holiday', parts[3];
    exception when insufficient_privilege then null; end;
    if public.support_badge() <> 0 then raise exception 'DESK FAIL [d]: % sees a support badge', parts[3]; end if;
    if (select count(*) from public.support_holidays) <> 0 then raise exception 'DESK FAIL [d]: % read the holidays', parts[3]; end if;
    if (select count(*) from public.support_visits) <> 0 then raise exception 'DESK FAIL [d]: % read the visits', parts[3]; end if;
  end loop;
  perform public._sd_as('');
end $$;
reset role;

-- == (d), (e), (f) The real admin works the queue ===============================
set local role authenticated;
do $$
declare
  v_t uuid; v_test uuid; v_n int; r jsonb; v jsonb; v_msg uuid;
begin
  perform public._sd_as('5d100000-0000-4000-8000-000000000007', 'aal2');
  select q.id into v_t from public.support_queue() q where q.subject = 'Grease gun';
  if v_t is null then raise exception 'DESK FAIL [d]: the admin cannot see a real request in the queue'; end if;
  if exists (select 1 from public.support_queue() q where q.is_test) then
    raise exception 'DESK FAIL [d]: the queue shows test cases by default';
  end if;
  select q.id into v_test from public.support_queue('active', null, null, true) q where q.subject = 'Test question';
  if v_test is null then raise exception 'DESK FAIL [d]: test cases cannot be shown on request'; end if;
  if not exists (select 1 from public.support_queue('unanswered') q where q.id = v_t) then
    raise exception 'DESK FAIL [d]: an unanswered request is not under "unanswered"';
  end if;
  v_n := public.support_badge();
  if v_n < 7 then raise exception 'DESK FAIL [d]: the badge counts % real requests waiting', v_n; end if;
  v := public.support_overview();
  if (v->>'new')::int < 7 then raise exception 'DESK FAIL [d]: the overview counts % new requests', v->>'new'; end if;
  if jsonb_array_length(v->'attention') = 0 then raise exception 'DESK FAIL [d]: nothing needs attention'; end if;

  -- An internal note, then a public reply.
  perform public.support_add_note(v_t, 'Called the dealer about the grease spec.');
  r := public.support_reply(v_t, 'Use lithium EP2, it is in the manual on page 40.');
  if r->'customer'->>'email' <> 'desk.mechanic.a@example.test' then
    raise exception 'DESK FAIL [e]: the reply does not say whom to email: %', r;
  end if;
  v_msg := (r->>'message_id')::uuid;
  perform public.support_mark_emailed(v_msg, null);

  -- Assigning: nobody but a real admin.
  begin
    perform public.support_assign(v_t, '5d100000-0000-4000-8000-000000000001');
    raise exception 'DESK FAIL [f]: a case was assigned to a farm owner';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.support_assign(v_t, '5d100000-0000-4000-8000-000000000008');
    raise exception 'DESK FAIL [f]: a case was assigned to a test admin';
  exception when invalid_parameter_value then null; end;
  perform public.support_assign(v_t, '5d100000-0000-4000-8000-000000000007');

  -- Resolving needs words.
  begin
    perform public.support_set_status(v_t, 'resolved', '   ');
    raise exception 'DESK FAIL [f]: a case was resolved with no resolution';
  exception when invalid_parameter_value then null; end;

  -- A case for a customer who phoned: only for someone on that farm.
  begin
    perform public.support_open_for_customer('5d000000-0000-4000-8000-00000000000a',
      '5d100000-0000-4000-8000-000000000005', 'Phoned', 'Called about QR stickers.', 'phone');
    raise exception 'DESK FAIL [g]: a case was opened for a person on another farm';
  exception when invalid_parameter_value then null; end;
  perform public.support_open_for_customer('5d000000-0000-4000-8000-00000000000a',
    '5d100000-0000-4000-8000-000000000001', 'Phoned about stickers', 'Ten more QR stickers, posted Monday.', 'phone');

  -- The client page's read.
  v := public.admin_client('5d000000-0000-4000-8000-00000000000a');
  if jsonb_array_length(v->'people') <> 4 then
    raise exception 'DESK FAIL [d]: the client page lists % people on farm A, not 4', jsonb_array_length(v->'people');
  end if;
  if not exists (select 1 from jsonb_array_elements(v->'people') p
                  where p->>'name' = 'Owner A' and p->>'last_sign_in_at' is not null) then
    raise exception 'DESK FAIL [d]: the client page does not say when the owner last signed in';
  end if;
  perform public._sd_as('');
end $$;
reset role;

-- What the customer now sees: the reply, never the note.
set local role authenticated;
do $$
declare v jsonb; v_t uuid; v_n int;
begin
  perform public._sd_as('5d100000-0000-4000-8000-000000000004');
  select r.id into v_t from public.my_help_requests() r where r.subject = 'Grease gun';
  v := public.my_help_request(v_t);
  if not exists (select 1 from jsonb_array_elements(v->'messages') m where m->>'body' like 'Use lithium%' and m->>'author_kind' = 'staff') then
    raise exception 'DESK FAIL [e]: the customer cannot read Rapid Rise''s answer';
  end if;
  if exists (select 1 from jsonb_array_elements(v->'messages') m where m->>'body' like 'Called the dealer%') then
    raise exception 'DESK FAIL [e]: an internal note reached the customer';
  end if;
  if exists (select 1 from jsonb_array_elements(v->'messages') m where m->>'author_kind' = 'staff' and m->>'author_name' is not null) then
    raise exception 'DESK FAIL [e]: a staff member''s name reached the customer';
  end if;
  if v->>'status' <> 'waiting' then raise exception 'DESK FAIL [e]: after the answer the case is %', v->>'status'; end if;
  if not (select r.answered from public.my_help_requests() r where r.id = v_t) then
    raise exception 'DESK FAIL [e]: the list does not mark the request answered';
  end if;
  select count(*) into v_n from public.notifications n
   where n.user_id = '5d100000-0000-4000-8000-000000000004' and n.template = 'support_reply';
  if v_n <> 1 then raise exception 'DESK FAIL [e]: the customer got % reply alerts', v_n; end if;

  -- They reply: the case reopens and Rapid Rise hears.
  perform public.reply_to_help_request(v_t, 'Thanks, found it.');
  if (public.my_help_request(v_t))->>'status' <> 'open' then
    raise exception 'DESK FAIL [e]: a customer reply did not put the case back with us';
  end if;

  -- The owner sees the case staff opened for them.
  perform public._sd_as('5d100000-0000-4000-8000-000000000001');
  if not exists (select 1 from public.my_help_requests() r where r.subject = 'Phoned about stickers') then
    raise exception 'DESK FAIL [g]: the customer does not see the case logged from their call';
  end if;
  perform public._sd_as('');
end $$;
reset role;

do $$ begin
  if not exists (select 1 from public.notifications n where n.template = 'support_customer_reply'
                  and n.user_id = '5d100000-0000-4000-8000-000000000007' and n.farm_id is null) then
    raise exception 'DESK FAIL [e]: Rapid Rise was not told the customer replied';
  end if;
  if (select first_response_at from public.support_tickets where subject = 'Grease gun') is null then
    raise exception 'DESK FAIL [e]: the first answer did not stamp first_response_at';
  end if;
  if (select emailed_at from public.support_ticket_messages where body like 'Use lithium%') is null then
    raise exception 'DESK FAIL [e]: the reply email''s outcome was not recorded';
  end if;
end $$;

-- Resolved, with words, names who resolved it.
set local role authenticated;
do $$
declare v_t uuid;
begin
  perform public._sd_as('5d100000-0000-4000-8000-000000000007', 'aal2');
  select q.id into v_t from public.support_queue('all') q where q.subject = 'Grease gun';
  perform public.support_set_status(v_t, 'resolved', 'Grease spec sent; customer confirmed.');
  perform public._sd_as('');
end $$;
reset role;
do $$ begin
  if (select resolved_by from public.support_tickets where subject = 'Grease gun') <> '5d100000-0000-4000-8000-000000000007' then
    raise exception 'DESK FAIL [f]: resolving did not record who resolved it';
  end if;
end $$;

-- == (g) Support visits ==========================================================
set local role authenticated;
do $$
declare v_n int;
begin
  perform public._sd_as('5d100000-0000-4000-8000-000000000007', 'aal2');
  begin
    perform public.support_visit_start('5d000000-0000-4000-8000-00000000000a', '   ');
    raise exception 'DESK FAIL [g]: support mode was entered with no reason';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.support_visit_start('5d000000-0000-4000-8000-00000000000a', null,
      (select id from public.support_tickets where subject = 'Test question'));
    raise exception 'DESK FAIL [g]: a case from another farm stood in for a reason';
  exception when invalid_parameter_value then null; end;
  perform public.support_visit_start('5d000000-0000-4000-8000-00000000000a', 'Setting up their machines on the phone');
  perform public.support_visit_end('5d000000-0000-4000-8000-00000000000a');

  perform public._sd_as('5d100000-0000-4000-8000-000000000001');
  select count(*) into v_n from public.my_farm_support_visits('5d000000-0000-4000-8000-00000000000a') v
   where v.reason = 'Setting up their machines on the phone' and v.ended_at is not null and v.admin_name = 'Desk Admin';
  if v_n <> 1 then raise exception 'DESK FAIL [g]: the owner does not see the visit, its end and who made it'; end if;

  perform public._sd_as('5d100000-0000-4000-8000-000000000002');
  select count(*) into v_n from public.my_farm_support_visits('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 0 then raise exception 'DESK FAIL [g]: a manager sees the support visits'; end if;
  perform public._sd_as('5d100000-0000-4000-8000-000000000005');
  select count(*) into v_n from public.my_farm_support_visits('5d000000-0000-4000-8000-00000000000a');
  if v_n <> 0 then raise exception 'DESK FAIL [g]: another farm''s owner sees farm A''s visits'; end if;
  perform public._sd_as('');
end $$;
reset role;

-- == (h) Rapid Rise invites an owner; nobody else does ===========================
-- Service role only, as the client page calls it: the id passed is the confirmed admin.
do $$
declare r jsonb;
begin
  insert into auth.users (id, email) values ('5d100000-0000-4000-8000-00000000000c', 'desk.new.owner@example.test');
  r := public.team_invite_existing('5d000000-0000-4000-8000-00000000000b', '5d100000-0000-4000-8000-000000000007',
         'desk.new.owner@example.test', 'owner', 'New Owner', 'en');
  if r->>'outcome' <> 'created' then raise exception 'DESK FAIL [h]: Rapid Rise could not invite an owner: %', r; end if;
  if (select role::text from public.users where id = '5d100000-0000-4000-8000-00000000000c') <> 'owner' then
    raise exception 'DESK FAIL [h]: the invited owner is not an owner';
  end if;
  begin
    perform public.team_invite_existing('5d000000-0000-4000-8000-00000000000b', '5d100000-0000-4000-8000-000000000008',
      'desk.someone@example.test', 'owner', 'Someone', 'en');
    raise exception 'DESK FAIL [h]: a test admin invited somebody';
  exception when insufficient_privilege then null; end;
  begin
    perform public.team_invite_existing('5d000000-0000-4000-8000-00000000000b', '5d100000-0000-4000-8000-000000000005',
      'desk.someone@example.test', 'owner', 'Someone', 'en');
    raise exception 'DESK FAIL [h]: a farm owner made somebody else an owner';
  exception when invalid_parameter_value then null; end;
end $$;

-- == (i) Grants ===================================================================
do $$
declare f text; v text;
begin
  foreach f in array array[
    'public.support_contact()',
    'public.support_update_settings(text,text,text,time,time,time,time,text)',
    'public.support_holiday_set(date,text)', 'public.support_holiday_remove(date)',
    'public.support_visit_start(uuid,text,uuid)', 'public.support_visit_end(uuid)',
    'public.my_farm_support_visits(uuid)',
    'public.open_help_request(text,text,jsonb,uuid,text)', 'public.my_help_requests(uuid)',
    'public.my_help_request(uuid)', 'public.reply_to_help_request(uuid,text)',
    'public.support_queue(text,text,text,boolean,uuid)', 'public.support_ticket(uuid)',
    'public.support_reply(uuid,text,text)', 'public.support_add_note(uuid,text,text)',
    'public.support_set_status(uuid,text,text)', 'public.support_staff()',
    'public.support_assign(uuid,uuid)',
    'public.support_open_for_customer(uuid,uuid,text,text,text,text)',
    'public.support_badge()', 'public.support_overview(boolean)',
    'public.support_mark_emailed(uuid,text)', 'public.admin_client(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'DESK FAIL [i]: anon may execute %', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception 'DESK FAIL [i]: a signed-in session cannot execute %', f;
    end if;
  end loop;
  foreach f in array array[
    'app.support_due_at(timestamptz)', 'app.support_working_day(date)',
    'app.support_customer_can_see(uuid)', 'app.support_take_message_slot()',
    'app.notify_rr_support(uuid,text,jsonb)', 'app.notify_support_customer(uuid,text)',
    'app.support_ticket_mark_test()', 'app.team_invite_actor_role(uuid,uuid)'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      raise exception 'DESK FAIL [i]: the engine % is directly executable', f;
    end if;
  end loop;
  -- The old three-argument form is gone, so PostgREST resolves one function by name.
  if to_regprocedure('public.open_help_request(text,text,jsonb)') is not null then
    raise exception 'DESK FAIL [i]: the old open_help_request signature is still there (ambiguous by name)';
  end if;
  -- The tables are Rapid Rise's: nothing granted to anon, no writes for a signed-in session.
  foreach v in array array['support_ticket_messages', 'support_visits', 'support_holidays', 'support_settings'] loop
    if has_table_privilege('anon', 'public.' || v, 'select') then
      raise exception 'DESK FAIL [i]: anon may read %', v;
    end if;
    if has_table_privilege('authenticated', 'public.' || v, 'insert')
       or has_table_privilege('authenticated', 'public.' || v, 'update')
       or has_table_privilege('authenticated', 'public.' || v, 'delete') then
      raise exception 'DESK FAIL [i]: a signed-in session may write % directly', v;
    end if;
  end loop;
end $$;

rollback;
