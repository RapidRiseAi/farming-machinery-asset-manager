-- 20260909140000_billing_release_failure_notice.sql
-- A failure notice that did not send must be tried again.
--
-- WHY THIS REVERSES A DECISION MADE TWO DAYS AGO
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260907120000` gave receipts a `release` — a failed send hands the claim back so the
-- nightly pass retries — and deliberately did NOT give one to failure notices. The
-- reasoning was that re-sending "your payment failed" every night over a full mailbox
-- would harass a customer about our problem.
--
-- Driving it against production showed the harm runs the other way. Compare the two
-- outcomes honestly:
--
--   don't release  a transient provider error (a Resend blip, a rate limit, an expired
--                  key) means the farmer is NEVER told their payment failed. They find
--                  out 31 days later when their plan narrows. Silent, and unrecoverable.
--
--   do release     a permanently bad address logs a failure every night. That is noise in
--                  a log, and the mailbox being harassed does not work anyway.
--
-- Never being told is worse than being told twice, and it is worse by a wide margin: one
-- is an annoyance, the other is a customer losing what they pay for with no warning. So
-- the notice now behaves exactly like the receipt.
--
-- The retry is naturally bounded: each FAILED ATTEMPT carries its own claim, and the
-- dunning ladder only produces a handful per cycle.

create or replace function app.release_billing_failure_notice(p_attempt uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.billing_payment_attempts
     set notified_at = null
   where id = p_attempt
     and status = 'failed';
$$;

comment on function app.release_billing_failure_notice(uuid) is
  'Hands a failure notice back when the send failed, so tonight''s pass tries again. A '
  'notice nobody received must not look sent — the same rule receipts follow, and for a '
  'stronger reason: this is the message that says access is about to narrow.';

create or replace function public.billing_release_failure_notice(p_attempt uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.release_billing_failure_notice(p_attempt);
$$;

revoke execute on function app.release_billing_failure_notice(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.billing_release_failure_notice(uuid)
  from public, anon, authenticated;
grant  execute on function public.billing_release_failure_notice(uuid) to service_role;
