-- 20260912170000_support_ticket_delivery.sql
-- Getting the case to the dashboard it is worked in, and knowing when it did not arrive.
--
-- Tickets are read in RapidRise OS. FleetWise posts them there, and the whole value of
-- doing that is undone if a failed post is silent — the dispute that arrived while the
-- integration was down is exactly the one somebody needed to see, and a 48-business-hour
-- clock does not pause for an outage.
--
-- So delivery is RECORDED, not attempted and forgotten. The same rule the receipts took
-- (`20260907120000`): a send that fails must not leave the record looking sent, because
-- "we told somebody" is the claim that costs the most when it is wrong.
--
-- WHY NOT A CLAIM/RELEASE PAIR LIKE RECEIPTS
-- ─────────────────────────────────────────────────────────────────────────────
-- A receipt has two racing senders — the webhook and the nightly pass — so it needs a
-- claim to stop both sending. A ticket post is idempotent at the RECEIVER by contract: the
-- payload carries the ticket's uuid, and RapidRise OS upserts on it. Two posts of the same
-- case are one case there. That makes the simpler shape correct here, and a claim would be
-- machinery defending against something that is not a problem.

alter table public.support_tickets
  add column if not exists posted_at  timestamptz,
  add column if not exists post_error text,
  -- How many times we have tried. A case that has failed twenty times is a broken
  -- integration, not a transient, and the difference should be visible without reading logs.
  add column if not exists post_attempts integer not null default 0;

comment on column public.support_tickets.posted_at is
  'When this case reached the RapidRise OS support dashboard. Null means it has not — which '
  'is a thing to act on, not a thing to assume.';

-- What still has to go. Ordered by deadline so a dispute with a clock is retried before a
-- refund record that can wait.
create or replace function app.support_tickets_to_post(p_limit integer default 50)
returns table (id uuid, kind support_ticket_kind, post_attempts integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.kind, t.post_attempts
    from public.support_tickets t
   where t.posted_at is null
     -- Give up loudly rather than hammering a broken endpoint for ever. Twenty tries with
     -- the nightly pass is three weeks of trying; past that it is somebody's job, not a
     -- retry's.
     and t.post_attempts < 20
   order by t.due_at nulls last, t.opened_at
   limit greatest(coalesce(p_limit, 50), 1);
$$;

-- Record the outcome. Success clears the error; failure keeps the case unposted and says
-- why, so the next pass tries again and a person can see what is wrong.
create or replace function app.record_support_ticket_post(p_ticket uuid, p_error text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.support_tickets
     set posted_at     = case when p_error is null then now() else posted_at end,
         post_error    = p_error,
         post_attempts = post_attempts + 1,
         updated_at    = now()
   where id = p_ticket;
end $$;

create or replace function public.support_tickets_to_post(p_limit integer default 50)
returns table (id uuid, kind support_ticket_kind, post_attempts integer)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.support_tickets_to_post(p_limit);
$$;

create or replace function public.record_support_ticket_post(p_ticket uuid, p_error text default null)
returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.record_support_ticket_post(p_ticket, p_error);
$$;

-- Engines to nobody; wrappers to the service role alone. A browser that could mark a case
-- posted could hide a dispute from the people who have two days to answer it.
revoke execute on function app.support_tickets_to_post(integer) from public, anon, authenticated, service_role;
revoke execute on function app.record_support_ticket_post(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.support_tickets_to_post(integer) from public, anon, authenticated;
revoke execute on function public.record_support_ticket_post(uuid, text) from public, anon, authenticated;
grant  execute on function public.support_tickets_to_post(integer) to service_role;
grant  execute on function public.record_support_ticket_post(uuid, text) to service_role;
