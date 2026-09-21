-- 20260920130000_notification_email_delivery.sql
-- Alerts that reach a farmer who never opens the app.
--
-- THE GAP
-- =============================================================================
-- `notification_channel` has been `('whatsapp','inapp','email')` since 0006, and email has
-- never been delivered. Alerts go in-app and by web push, and push needs the app installed
-- and permission granted on the device. WhatsApp, the channel `SCOPE.md` §1 calls the
-- farmer's interface, waits on a provider.
--
-- So today a service falling due reaches an owner only if he opens FleetWise. `SCOPE.md`
-- §1 says he should get value "even if he personally never types anything", and email is
-- the one channel already live in this product: Resend sends receipts, statements,
-- verification and scheduled reports.
--
-- OPT-IN, AND OFF UNTIL SOMEBODY ASKS
-- =============================================================================
-- `notify_email` defaults to FALSE. Turning it on for every existing user would start
-- emailing sixteen farms on the next nightly run, which is a decision for the founder and
-- not a side effect of a migration. `/account` offers the switch; enabling it for a cohort
-- is one UPDATE when that decision is made.
--
-- THE SAME BOOKKEEPING AS PUSH
-- =============================================================================
-- A leased claim table, the same five-minute lease, the same retry-on-failure, and a
-- terminal mark only when the provider accepted the message (20260908112916). A temporary
-- failure at Resend must not discard a reminder, and a crash must not send it twice for
-- ever: the lease expires and the row is retried.

-- == The switch ==============================================================
alter table public.users
  add column if not exists notify_email boolean not null default false;

comment on column public.users.notify_email is
  'Send this person service, fault and licence alerts by email as well. Opt-in: push needs '
  'the app installed, and WhatsApp is not live.';

-- == The marker, mirroring push_sent_at ======================================
alter table public.notifications
  add column if not exists email_sent_at timestamptz;

create index if not exists notifications_email_pending_idx
  on public.notifications(user_id)
  where email_sent_at is null and deleted_at is null;

-- == The claim table =========================================================
create table if not exists public.notification_email_delivery (
  notification_id uuid primary key
    references public.notifications(id) on delete cascade,
  claim_id        uuid,
  claim_until     timestamptz,
  retry_after     timestamptz,
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now()
);

alter table public.notification_email_delivery enable row level security;
alter table public.notification_email_delivery force  row level security;
-- No policies: this is the worker's bookkeeping, and the worker is service_role. A browser
-- session has no business reading who has been emailed what.
grant all on public.notification_email_delivery to service_role;

-- == Claim a batch ===========================================================
create or replace function public.claim_notification_email(p_claim_id uuid, p_limit integer)
returns table (
  id uuid, user_id uuid, farm_id uuid, template text, payload jsonb
)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_claim_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid email claim' using errcode = '22023';
  end if;

  insert into public.notification_email_delivery (notification_id)
    select n.id from public.notifications n
    where n.deleted_at is null and n.email_sent_at is null and n.user_id is not null
      and (n.deliver_after is null or n.deliver_after <= clock_timestamp())
      and not exists (
        select 1 from public.notification_email_delivery d where d.notification_id = n.id)
    order by n.created_at, n.id limit p_limit
    on conflict (notification_id) do nothing;

  return query
    with candidates as materialized (
      select d.notification_id from public.notification_email_delivery d
      join public.notifications n on n.id = d.notification_id
      where n.deleted_at is null and n.email_sent_at is null and n.user_id is not null
        and (n.deliver_after is null or n.deliver_after <= clock_timestamp())
        and (d.claim_until is null or d.claim_until <= clock_timestamp())
        and (d.retry_after is null or d.retry_after <= clock_timestamp())
      order by n.created_at, n.id limit p_limit for update of d skip locked
    ), claimed as (
      update public.notification_email_delivery d
      set claim_id = p_claim_id, claim_until = clock_timestamp() + interval '5 minutes',
          attempts = d.attempts + 1
      from candidates c where d.notification_id = c.notification_id
      returning d.notification_id
    )
    select n.id, n.user_id, n.farm_id, n.template, n.payload
    from claimed c join public.notifications n on n.id = c.notification_id;
end $$;

-- == Finish one ==============================================================
-- `p_terminal` means "this row is done with": the provider accepted it, or there is
-- nothing to send it to. Anything else releases the claim with a back-off so the reminder
-- is tried again rather than quietly dropped.
create or replace function public.finish_notification_email(
  p_notification_id uuid, p_claim_id uuid, p_terminal boolean, p_error text default null
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_rows integer;
begin
  if p_notification_id is null or p_claim_id is null or p_terminal is null then
    raise exception 'Invalid email finish' using errcode = '22023';
  end if;

  update public.notification_email_delivery d
     set claim_id = null,
         claim_until = null,
         retry_after = case when p_terminal then null
                            -- 5, 10, 20 … minutes, capped at an hour.
                            else clock_timestamp()
                                 + least(interval '1 hour',
                                         interval '5 minutes' * power(2, least(d.attempts, 4))) end,
         last_error = left(p_error, 500)
   where d.notification_id = p_notification_id
     and d.claim_id = p_claim_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  if p_terminal then
    update public.notifications
       set email_sent_at = clock_timestamp()
     where id = p_notification_id and email_sent_at is null;
  end if;
  return true;
end $$;

revoke all on function public.claim_notification_email(uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_notification_email(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_notification_email(uuid, integer) to service_role;
grant execute on function public.finish_notification_email(uuid, uuid, boolean, text) to service_role;

-- == The preference, on the screen that already owns the others ==============
-- The four-argument version goes rather than gaining a defaulted fifth: PostgREST resolves
-- by named arguments, and two candidates would start answering "function is not unique".
drop function if exists public.set_notification_prefs(boolean, boolean, int, int);

create or replace function public.set_notification_prefs(
  p_inapp boolean, p_push boolean, p_email boolean, p_quiet_start int, p_quiet_end int
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update users set
    notify_inapp      = coalesce(p_inapp, notify_inapp),
    notify_push       = coalesce(p_push,  notify_push),
    notify_email      = coalesce(p_email, notify_email),
    quiet_hours_start = p_quiet_start,
    quiet_hours_end   = p_quiet_end
  where id = auth.uid();
end $$;

revoke execute on function public.set_notification_prefs(boolean, boolean, boolean, int, int)
  from public, anon;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean, int, int)
  to authenticated;
