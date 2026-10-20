-- One request, one effect (interaction safety, release 2).
--
-- A save on farm signal can reach the server while its answer never comes back. The person
-- sees a failure and tries again; a dialog closed mid-save is reopened and saved again; two
-- tabs submit the same form. For creates, sends and payments each of those used to run the
-- work a second time: two recurring schedules billing the customer twice a month, a payment
-- recorded twice, a second invoice from one quote, the same email twice.
--
-- Every repeatable action now carries a request id from its form (RequestIdInput) and
-- claims it here before doing anything. A replay of a finished claim gets the first
-- attempt's outcome (where it sent the person) instead of a second effect; a replay while
-- the first is still running is told so. A failed attempt releases its claim so the retry
-- runs. Claims are the caller's own: an id belongs to one person and one action.

create table public.request_claims (
  request_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  action text not null check (length(action) between 1 and 80),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Where the first attempt sent the person, or the JSON it answered with. Never a secret.
  outcome text check (outcome is null or length(outcome) <= 2000)
);
create index request_claims_user_claimed on public.request_claims (user_id, claimed_at);

alter table public.request_claims enable row level security;
revoke all on public.request_claims from public, anon, authenticated;
grant all on public.request_claims to service_role;

-- 'new': run it. 'done': it already ran, here is its outcome. 'running': it is running now.
create function public.claim_request(p_request uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_claim public.request_claims%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_request is null or p_action is null or length(p_action) not between 1 and 80 then
    raise exception 'A request id and an action are required.' using errcode = '22023';
  end if;

  -- Old claims of this person go as new ones come; two days covers any retry.
  delete from public.request_claims
   where user_id = v_user and claimed_at < now() - interval '2 days';

  insert into public.request_claims (request_id, user_id, action)
  values (p_request, v_user, p_action)
  on conflict (request_id) do nothing;
  if found then
    return jsonb_build_object('state', 'new');
  end if;

  select * into v_claim from public.request_claims where request_id = p_request for update;
  -- Someone else's id, or one id reused for a different action: never answer across them.
  if v_claim.user_id is distinct from v_user or v_claim.action is distinct from p_action then
    raise exception 'That request id is already in use.' using errcode = '23505';
  end if;
  if v_claim.finished_at is not null then
    return jsonb_build_object('state', 'done', 'outcome', v_claim.outcome);
  end if;
  -- Longer than any function may run (300 s), so the first attempt is gone: take it over.
  if v_claim.claimed_at < now() - interval '5 minutes' then
    update public.request_claims set claimed_at = now() where request_id = p_request;
    return jsonb_build_object('state', 'new');
  end if;
  return jsonb_build_object('state', 'running');
end $$;

create function public.finish_request(p_request uuid, p_outcome text) returns void
language sql security definer set search_path = '' as $$
  update public.request_claims
     set finished_at = now(), outcome = left(p_outcome, 2000)
   where request_id = p_request and user_id = auth.uid() and finished_at is null;
$$;

-- The attempt failed before its effect: the retry must run.
create function public.release_request(p_request uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.request_claims
   where request_id = p_request and user_id = auth.uid() and finished_at is null;
$$;

revoke all on function public.claim_request(uuid, text) from public, anon;
revoke all on function public.finish_request(uuid, text) from public, anon;
revoke all on function public.release_request(uuid) from public, anon;
grant execute on function public.claim_request(uuid, text) to authenticated;
grant execute on function public.finish_request(uuid, text) to authenticated;
grant execute on function public.release_request(uuid) to authenticated;
