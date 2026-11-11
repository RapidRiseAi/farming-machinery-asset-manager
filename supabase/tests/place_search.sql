\set ON_ERROR_STOP on
-- The place search's shared cache and request slot (20261111130000): one request a second for
-- all of FLEETWISE, answers kept a month, and nothing of it reachable from a browser.
begin;

-- == One slot, 1.1 seconds apart, whoever asks ===============================
do $t$
declare a integer; b integer; c integer;
begin
  update public.place_search_slot set next_at = clock_timestamp() - interval '1 minute';
  a := public.book_place_search_slot();
  b := public.book_place_search_slot();
  c := public.book_place_search_slot();
  if a <> 0 then raise exception 'the first request had to wait % ms', a; end if;
  if b not between 1000 and 1100 then raise exception 'the second request waits % ms, not about 1100', b; end if;
  if c not between 2100 and 2200 then raise exception 'the third request waits % ms, not about 2200', c; end if;

  -- Without its row the slot starts again rather than failing every search.
  delete from public.place_search_slot;
  if public.book_place_search_slot() <> 0 then raise exception 'a missing slot made the request wait'; end if;
  if (select count(*) from public.place_search_slot) <> 1 then raise exception 'the slot row was not put back'; end if;
end $t$;

-- == Answers kept a month, and only real answers =============================
insert into public.place_search_cache (query, places, fetched_at) values
  ('za6en|old town', '[]', now() - interval '31 days'),
  ('za6en|nelspruit', '[{"label":"Mbombela, Ehlanzeni, Mpumalanga","lat":-25.47,"lng":30.97}]', now());

do $t$ begin
  if public.cron_purge_place_cache() <> 1 then raise exception 'the purge removed the wrong number'; end if;
  if not exists (select 1 from public.place_search_cache where query = 'za6en|nelspruit') then
    raise exception 'a fresh answer was purged';
  end if;
  begin
    insert into public.place_search_cache (query, places) values ('ab', '[]');
    raise exception 'a two-letter search was kept';
  exception when check_violation then null;
  end;
  begin
    insert into public.place_search_cache (query, places) values ('za6en|pretoria', '{"label":"Pretoria"}');
    raise exception 'an answer that is not a list was kept';
  exception when check_violation then null;
  end;
end $t$;

-- == Service only ============================================================
do $t$ begin
  if has_function_privilege('authenticated', 'public.book_place_search_slot()', 'EXECUTE')
     or has_function_privilege('anon', 'public.book_place_search_slot()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cron_purge_place_cache()', 'EXECUTE')
     or has_function_privilege('anon', 'public.cron_purge_place_cache()', 'EXECUTE') then
    raise exception 'a browser session can book place-search slots or empty the cache';
  end if;
  if has_table_privilege('authenticated', 'public.place_search_cache', 'select')
     or has_table_privilege('anon', 'public.place_search_cache', 'select')
     or has_table_privilege('authenticated', 'public.place_search_cache', 'insert')
     or has_table_privilege('authenticated', 'public.place_search_slot', 'update')
     or has_table_privilege('anon', 'public.place_search_slot', 'select') then
    raise exception 'a browser session can read the place cache or move the slot';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.place_search_cache'::regclass and relrowsecurity and relforcerowsecurity)
     or not exists (select 1 from pg_class where oid = 'public.place_search_slot'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'the place tables are not FORCE RLS';
  end if;
end $t$;

rollback;
