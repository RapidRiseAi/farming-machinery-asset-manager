-- 20260911200000_terms_acceptance.sql
-- Recording that somebody agreed, and to WHICH version.
--
-- WHY A VERSION AND NOT JUST A TIMESTAMP
-- ─────────────────────────────────────────────────────────────────────────────
-- Terms change. A timestamp alone says "they agreed to whatever was on the page that day",
-- which is precisely the thing that cannot be reconstructed later — the page is code, and
-- code is redeployed. Storing the version the visitor was shown means the question "what
-- did this person actually accept" has an answer that does not depend on git archaeology.
--
-- The version is a DATE string (`2026-09-11`), not a counter, because the thing a human
-- asks is "which wording was live then". `TERMS_VERSION` in `src/lib/legal.ts` is the one
-- place it is set, and the sign-up form posts it so the value recorded is the value the
-- page rendered rather than whatever the server thinks is current by the time the form
-- arrives.
--
-- WHY NOT A SEPARATE TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- A history of every acceptance by every user is a reasonable thing to want, and it is not
-- what is needed to go live: one acceptance per account, with its version, answers the
-- question the Consumer Protection Act and ECTA §43 ask. A table can be added later
-- without moving these columns, and adding one now would be building an audit trail for an
-- event that has happened zero times.
--
-- EXISTING USERS ARE NOT BACKFILLED
-- ─────────────────────────────────────────────────────────────────────────────
-- Deliberately. Stamping "accepted" onto fourteen accounts that were created by hand before
-- any terms existed would be recording a consent nobody gave — the exact thing this column
-- exists to make truthful. They stay null, which is the honest answer.

begin;

alter table public.users
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

comment on column public.users.terms_accepted_at is
  'When this person ticked the box at sign-up. Null for accounts created before terms '
  'existed, or created for somebody by an administrator — deliberately NOT backfilled, '
  'because recording a consent nobody gave is worse than recording none.';
comment on column public.users.terms_version is
  'The version string shown on the page they accepted, e.g. ''2026-09-11''. Kept because '
  'the wording lives in code and code is redeployed, so the timestamp alone could not '
  'answer "what did they agree to".';

commit;
