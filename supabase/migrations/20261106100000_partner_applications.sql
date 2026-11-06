-- 20261106100000_partner_applications.sql
-- A business asking to become a Fleet Wise partner (founder decision, 6 November 2026).
--
-- There is no price and no plan to buy. An application is a request to Rapid Rise, who
-- contact the business and agree terms, pricing and any partnership agreement according to
-- what they offer, whether they qualify, and who can vouch for them. Only Rapid Rise reads
-- these, and an application creates nothing: the account comes when Rapid Rise approves it.
--
-- The public form writes through the service role after its own checks, so no signed-in or
-- anonymous role may insert. `vouch` may name other people: the form asks the applicant to
-- name only people who agreed, and an application can be deleted once it is decided.

create table if not exists public.partner_applications (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null,
  kind          public.contractor_kind not null,
  contact_name  text not null,
  email         text not null,
  phone         text not null,
  area          text not null,
  website       text,
  offer         text not null,
  vouch         text,
  -- What they think they want. Null means "not sure yet"; Rapid Rise sets the real one.
  plan_interest public.workshop_plan,
  status        text not null default 'new',
  review_notes  text,
  workshop_id   uuid references public.workshops(id) on delete set null,
  reviewed_by   uuid references public.users(id) on delete set null,
  reviewed_at   timestamptz,
  locale        text not null default 'en',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint partner_applications_status_ck
    check (status in ('new', 'talking', 'approved', 'declined')),
  constraint partner_applications_lengths_ck check (
    length(business_name) between 2 and 120
    and length(contact_name) between 2 and 120
    and length(email) between 5 and 200
    and length(phone) between 6 and 40
    and length(area) between 2 and 200
    and coalesce(length(website), 0) <= 200
    and length(offer) between 2 and 2000
    and coalesce(length(vouch), 0) <= 2000
    and coalesce(length(review_notes), 0) <= 4000
  )
);

-- One open application per address: asking twice is the same request.
create unique index if not exists partner_applications_open_email_idx
  on public.partner_applications (lower(email)) where status in ('new', 'talking');
create index if not exists partner_applications_status_idx
  on public.partner_applications (status, created_at desc);

alter table public.partner_applications enable row level security;
alter table public.partner_applications force row level security;

create policy partner_applications_sel on public.partner_applications for select to authenticated
  using (app.is_rr_admin());
create policy partner_applications_upd on public.partner_applications for update to authenticated
  using (app.is_rr_admin()) with check (app.is_rr_admin());
create policy partner_applications_del on public.partner_applications for delete to authenticated
  using (app.is_rr_admin());

-- SECURITY.md 2b: every new table is born with full access for `authenticated`.
revoke all on public.partner_applications from public, anon, authenticated;
grant select, update, delete on public.partner_applications to authenticated;
grant all on public.partner_applications to service_role;

create trigger partner_applications_audit
  after insert or update or delete on public.partner_applications
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('partner_applications', 'rapid_rise', 'a business asking Rapid Rise for a partnership; no farm is party to it')
on conflict (table_name) do nothing;

comment on table public.partner_applications is
  'Requests to become a partner, reviewed by Rapid Rise (20261106100000). No price, no account until approved.';
