-- ─────────────────────────────────────────────────────────────────────────────
-- 0370 — user language intent + wording tone
--
-- Two additive columns on `users`. No RLS change: `users_upd` (0101) already lets a
-- person update their own row, which is exactly who writes these.
--
-- 1. `language_set_at` — WHY a nullable timestamp rather than nothing:
--    `users.language` is `not null default 'en'`, so "I chose English" and "nobody ever
--    asked me" were the same value. That made a real bug unfixable: someone picks
--    Afrikaans on the login screen, signs in, and every page comes back English —
--    because the profile default silently outranked the only explicit choice the person
--    had ever made. With this stamp, an unset profile can adopt the device choice while
--    a deliberate choice is never overwritten (which matters on a shared farm-office PC).
--
-- 2. `tone` — friendly vs professional wording, chosen per person. The dictionaries
--    stay one per language; `professional` is an OVERLAY of only the keys whose wording
--    actually differs, so there is no second translation to keep at parity.
-- ─────────────────────────────────────────────────────────────────────────────

alter table users add column if not exists language_set_at timestamptz;

comment on column users.language_set_at is
  'When the person last chose their language themselves. NULL = never chosen, so a '
  'device-level choice made before sign-in may be adopted. Set by setLanguage.';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_tone') then
    create type app_tone as enum ('friendly','professional');
  end if;
end $$;

alter table users add column if not exists tone app_tone not null default 'friendly';

comment on column users.tone is
  'Wording register for this person''s interface: friendly (default) or professional. '
  'Language and tone are independent — either language can be read in either tone.';

-- Anyone already off the default cannot have got there by accident, so their choice is
-- deliberate and must not be overwritten by a device cookie at their next sign-in.
update users set language_set_at = now()
where language <> 'en' and language_set_at is null;
