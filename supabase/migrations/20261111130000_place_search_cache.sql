-- The route planner's place search, kept within OpenStreetMap's rules (docs/ROUTING.md).
--
-- The public search (nominatim.openstreetmap.org) allows at most one request a second, and
-- for an app "the sum of traffic by all your users should not exceed the limits"; it asks apps,
-- "if at all possible", to "set up a proxy and also enable caching of requests". The planner
-- now looks a trip's own place names up when it opens, so the same names go out again and
-- again, and a spacing kept in server memory only spaced requests within one server instance.
-- Both now live here, shared by every instance:
--
--   place_search_cache   what a search answered, by its normalised text, for 30 days
--                        (a search that found nothing, for a day)
--   place_search_slot    one row: when the application's next request may go
--
-- Service role only. Nothing here belongs to a business, and no person reads it.

create table if not exists public.place_search_cache (
  query      text primary key check (char_length(query) between 3 and 240),
  places     jsonb not null check (jsonb_typeof(places) = 'array' and jsonb_array_length(places) <= 10),
  fetched_at timestamptz not null default now()
);

alter table public.place_search_cache enable row level security;
alter table public.place_search_cache force row level security;
revoke all on public.place_search_cache from public, anon, authenticated;
grant select, insert, update, delete on public.place_search_cache to service_role;

create table if not exists public.place_search_slot (
  id      boolean primary key default true check (id),
  next_at timestamptz not null default now()
);

alter table public.place_search_slot enable row level security;
alter table public.place_search_slot force row level security;
revoke all on public.place_search_slot from public, anon, authenticated;
grant select, insert, update on public.place_search_slot to service_role;

insert into public.place_search_slot (id) values (true) on conflict (id) do nothing;

-- Books the next free moment for a request to the place search and answers how many
-- milliseconds to wait for it. The row lock queues concurrent callers, so each gets its own
-- moment, 1.1 seconds after the one before.
create or replace function public.book_place_search_slot()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_slot timestamptz;
begin
  update public.place_search_slot
     set next_at = greatest(clock_timestamp(), next_at) + interval '1100 milliseconds'
   where id
   returning next_at - interval '1100 milliseconds' into v_slot;
  if v_slot is null then
    insert into public.place_search_slot (id, next_at)
    values (true, clock_timestamp() + interval '1100 milliseconds')
    on conflict (id) do nothing;
    return 0;
  end if;
  return greatest(0, ceil(extract(epoch from (v_slot - clock_timestamp())) * 1000))::integer;
end $$;

revoke all on function public.book_place_search_slot() from public, anon, authenticated;
grant execute on function public.book_place_search_slot() to service_role;

-- Answers older than a month go; the next search for them asks again.
create or replace function public.cron_purge_place_cache()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v integer;
begin
  delete from public.place_search_cache where fetched_at < now() - interval '30 days';
  get diagnostics v = row_count;
  return v;
end $$;

revoke all on function public.cron_purge_place_cache() from public, anon, authenticated;
grant execute on function public.cron_purge_place_cache() to service_role;
