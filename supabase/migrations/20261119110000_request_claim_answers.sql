-- 20261119110000_request_claim_answers.sql
-- Room for a replayed answer, and old claims swept every night (task B3, repeat taps).
--
-- An assistant turn and an AI transcription are paid work. A request whose answer was lost
-- on farm signal and was sent again used to run (and be paid for) a second time. They now
-- claim their request id like every other repeatable request (20261018090000) and a replay
-- gets the first answer back. That answer is JSON larger than the 2,000 characters a claim
-- kept, so the outcome may now hold up to 64 KiB (the app finishes a claim only with an
-- answer that fits, and never stores a partial one).
--
-- A claim held a person's answer until that person next made a claim, which might be never.
-- The nightly job now removes every claim older than two days, the window a retry needs.
--
-- Additive and quick: the old check is replaced by a NOT VALID one, validated separately
-- (request_claims is small: two days of requests); finish_request keeps its signature.

alter table public.request_claims drop constraint if exists request_claims_outcome_check;
alter table public.request_claims
  add constraint request_claims_outcome_len check (outcome is null or length(outcome) <= 65536) not valid;
alter table public.request_claims validate constraint request_claims_outcome_len;

create or replace function public.finish_request(p_request uuid, p_outcome text) returns void
language sql security definer set search_path = '' as $$
  update public.request_claims
     set finished_at = now(), outcome = left(p_outcome, 65536)
   where request_id = p_request and user_id = auth.uid() and finished_at is null;
$$;
revoke all on function public.finish_request(uuid, text) from public, anon;
grant execute on function public.finish_request(uuid, text) to authenticated;

-- Every claim older than the retry window, whoever made it. Service role only (the nightly job).
create or replace function public.cron_sweep_request_claims() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from public.request_claims where claimed_at < now() - interval '2 days';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.cron_sweep_request_claims() from public, anon, authenticated;
grant execute on function public.cron_sweep_request_claims() to service_role;
