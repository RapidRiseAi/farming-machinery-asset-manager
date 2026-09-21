-- 20260918120000_signup_email_lookup.sql
-- Recognising somebody who has signed up before, at any customer count.
--
-- `/signup` has to answer one question before it creates anything: does this address
-- already own an account? Get it wrong and the person who abandoned a checkout last week
-- cannot come back, `createUser` fails on the duplicate, and they are handed a generic
-- "something went wrong" with no route forward. `docs/SIGNUP_AND_QUOTA_BILLING.md` §6
-- calls this the most likely thing to be got wrong and the most annoying to the customer,
-- and it was right.
--
-- WHAT IT WAS DOING
-- =============================================================================
-- `svc.auth.admin.listUsers()` with no arguments, then a scan of the result. That call is
-- PAGED and defaults to fifty rows, so the check was really "is this address among the
-- fifty most recent users". At 16 users it is correct. At 51 it starts missing, silently,
-- for exactly the oldest customers, and a returning customer is by definition not a
-- recent row. Nothing would have failed in a test; it would simply have begun turning
-- people away as the business grew.
--
-- WHY A FUNCTION AND NOT PAGINATION
-- =============================================================================
-- Paginating the admin API is correct and costs one HTTP round trip per fifty users on
-- the public sign-up path. `auth.users.email` is indexed; this is one index probe.
--
-- `auth` is not in PostgREST's exposed schema and never should be, so the wrapper lives in
-- `public` (the ONLY schema PostgREST exposes, see CLAUDE.md) and is SECURITY DEFINER to
-- reach across. That makes the grant the whole security story:
--
--   * `anon` and `authenticated` are revoked. An anonymous caller able to ask "does this
--     address have an account" is an account-enumeration oracle, and the sign-up form is
--     reachable by anybody with a browser. The FORM may ask this question because it has
--     already decided to act on the answer; a visitor may not ask it directly.
--   * `service_role` only, which is the same footing every other billing write is on.
--
-- It returns a BOOLEAN and never the row. There is no version of this that should hand
-- back a user id, a name or a confirmation timestamp: the caller needs to branch, not to
-- learn anything about somebody else's account.

create or replace function public.billing_signup_email_taken(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Lower-cased on both sides because Supabase Auth stores the address lower-cased and
  -- the form hands us whatever was typed. `/signup` already lower-cases before calling;
  -- doing it here as well means a future caller that forgets cannot create a second
  -- account on a capitalised spelling of an address that already exists.
  --
  -- SOFT-DELETED USERS ARE DELIBERATELY STILL "TAKEN". GoTrue's unique index on the
  -- address does not exclude a row carrying `deleted_at`, so `createUser` refuses that
  -- address whether or not the account was soft-deleted. Excluding them here would answer
  -- "available" and then hand the visitor the duplicate-key failure this function exists
  -- to prevent, the exact bug, reintroduced by a filter that looks like tidiness.
  select exists (
    select 1 from auth.users u
     where lower(u.email) = lower(trim(p_email))
  );
$$;

comment on function public.billing_signup_email_taken(text) is
  'Does this address already own an auth user? Service-role only: the sign-up action asks '
  'it in order to resume a stalled sign-up instead of failing on a duplicate. Replaced a '
  'paged listUsers() scan that only ever saw the fifty most recent users.';

revoke execute on function public.billing_signup_email_taken(text) from public, anon, authenticated;
grant  execute on function public.billing_signup_email_taken(text) to service_role;
