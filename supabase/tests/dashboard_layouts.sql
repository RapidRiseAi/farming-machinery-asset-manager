-- Each person's own dashboard board (20261105120000): own row only, own farms only, bounded.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('9f000000-0000-4000-9000-000000000001', 'Board Farm', 'professional', 'active'),
  ('9f000000-0000-4000-9000-000000000002', 'Other Farm', 'professional', 'active');
insert into public.farms (id, name, plan, status, is_test) values
  ('9f000000-0000-4000-9000-000000000003', 'Test Farm', 'professional', 'active', true);
insert into auth.users (id, email) values
  ('9f100000-0000-4000-9000-000000000001', 'board.owner@example.test'),
  ('9f100000-0000-4000-9000-000000000002', 'board.manager@example.test'),
  ('9f100000-0000-4000-9000-000000000003', 'board.tester@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('9f100000-0000-4000-9000-000000000001', '9f000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'board.owner@example.test'),
  ('9f100000-0000-4000-9000-000000000002', '9f000000-0000-4000-9000-000000000001', 'manager', 'Manager', 'board.manager@example.test');
insert into public.users (id, farm_id, role, name, email, is_test) values
  ('9f100000-0000-4000-9000-000000000003', '9f000000-0000-4000-9000-000000000003', 'owner', 'Tester', 'board.tester@example.test', true);

-- (a) The owner saves and reads back their own board.
set role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"9f100000-0000-4000-9000-000000000001","role":"authenticated"}', false);
insert into public.dashboard_layouts (user_id, farm_id, layout) values
  ('9f100000-0000-4000-9000-000000000001', '9f000000-0000-4000-9000-000000000001', '{"version":1,"items":[]}');
update public.dashboard_layouts set layout = '{"version":1,"items":[{"id":"a-1"}]}', updated_at = now()
 where user_id = '9f100000-0000-4000-9000-000000000001';
do $$ begin
  if (select layout -> 'items' -> 0 ->> 'id' from public.dashboard_layouts
       where user_id = '9f100000-0000-4000-9000-000000000001') is distinct from 'a-1' then
    raise exception 'BOARD FAIL [a]: the owner could not save and read back their board';
  end if;
end $$;

-- (b) Not for a farm they cannot reach, and not as somebody else.
do $$
declare v_ok boolean;
begin
  v_ok := false;
  begin
    insert into public.dashboard_layouts (user_id, farm_id, layout) values
      ('9f100000-0000-4000-9000-000000000001', '9f000000-0000-4000-9000-000000000002', '{"version":1,"items":[]}');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'BOARD FAIL [b]: a board was saved for a farm the person cannot reach'; end if;

  v_ok := false;
  begin
    insert into public.dashboard_layouts (user_id, farm_id, layout) values
      ('9f100000-0000-4000-9000-000000000002', '9f000000-0000-4000-9000-000000000001', '{"version":1,"items":[]}');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'BOARD FAIL [b]: the owner saved a board in the manager''s name'; end if;
end $$;

-- (c) A colleague on the same farm can neither see nor change the owner's board.
select pg_catalog.set_config('request.jwt.claims', '{"sub":"9f100000-0000-4000-9000-000000000002","role":"authenticated"}', false);
do $$
declare n integer;
begin
  if exists (select 1 from public.dashboard_layouts) then
    raise exception 'BOARD FAIL [c]: the manager can see the owner''s board';
  end if;
  update public.dashboard_layouts set layout = '{"version":1,"items":[]}';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BOARD FAIL [c]: the manager changed % board(s) not theirs', n; end if;
  delete from public.dashboard_layouts;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BOARD FAIL [c]: the manager deleted % board(s) not theirs', n; end if;
end $$;

-- (d) Bounded: not a layout, or far too big, is refused by the table itself.
do $$
declare v_ok boolean;
begin
  v_ok := false;
  begin
    insert into public.dashboard_layouts (user_id, farm_id, layout) values
      ('9f100000-0000-4000-9000-000000000002', '9f000000-0000-4000-9000-000000000001', '{"version":1}');
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'BOARD FAIL [d]: a layout with no items was stored'; end if;

  v_ok := false;
  begin
    insert into public.dashboard_layouts (user_id, farm_id, layout) values
      ('9f100000-0000-4000-9000-000000000002', '9f000000-0000-4000-9000-000000000001',
       jsonb_build_object('version', 1, 'items', jsonb_build_array(repeat('x', 25000))));
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'BOARD FAIL [d]: a 25 kB layout was stored'; end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- (e) Fenced: a test account's board never sits on a real farm, even written by the server.
do $$
declare v_ok boolean := false;
begin
  begin
    insert into public.dashboard_layouts (user_id, farm_id, layout) values
      ('9f100000-0000-4000-9000-000000000003', '9f000000-0000-4000-9000-000000000001', '{"version":1,"items":[]}');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'BOARD FAIL [e]: a test account''s board was stored on a real farm'; end if;
end $$;

-- (f) Structure: forced RLS, no anon access, the fence attached.
do $$ begin
  if not exists (select 1 from pg_class where oid = 'public.dashboard_layouts'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'BOARD FAIL [f]: RLS is not forced';
  end if;
  if has_table_privilege('anon', 'public.dashboard_layouts', 'select') then
    raise exception 'BOARD FAIL [f]: anon can read boards';
  end if;
end $$;

rollback;
\echo 'dashboard_layouts: PASS'
