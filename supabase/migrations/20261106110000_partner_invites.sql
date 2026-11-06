-- 20261106110000_partner_invites.sql
-- A link and code a farmer sends to any contractor (founder decision, 6 November 2026).
--
-- The farmer needs no email address for them: a business name is enough. The contractor
-- opens the link, types the code and their own email, and a sign-in email proves the address
-- is theirs. The login that creates reaches only what the farmer ticked.
--
-- == One link, one person ======================================================
-- The first person to give the right code claims the link for their email address. Anyone it
-- is forwarded to is refused, with or without the code, and the claim happens under a row
-- lock, so two people at once cannot both win. The same person may use it again until it
-- expires, which is what makes a lost sign-in email or a half-finished set-up recoverable.
-- Using it again only ever repeats the email: it never restores or widens access, and when
-- the farmer disconnects the contractor or removes the partner, the link dies with it.
--
-- == Why the link alone does nothing ===========================================
-- Mail scanners and WhatsApp's preview open every link in a message, so opening one must
-- change nothing: only the code and an address, posted from the page, do. Five wrong codes
-- lock it. Token and code are stored as hashes, the code keyed by its token, so this table
-- alone unlocks nothing.
--
-- Both functions below run as the caller, not as their owner: only the service role may call
-- them, and it can already read these tables, so elevated rights would add risk and no use.

create table if not exists public.partner_invites (
  id                  uuid primary key default gen_random_uuid(),
  farm_id             uuid not null references public.farms(id) on delete cascade,
  partner_id          uuid not null references public.partners(id) on delete cascade,
  token_hash          text not null unique,
  code_hash           text not null,
  -- What the farmer ticked, copied onto workshop_links when the link is claimed.
  see_all_vehicles    boolean not null default false,
  see_service_history boolean not null default false,
  see_costs           boolean not null default false,
  see_team            boolean not null default false,
  expires_at          timestamptz not null,
  failed_attempts     integer not null default 0,
  redeemed_at         timestamptz,
  redeemed_email      text,
  revoked_at          timestamptz,
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint partner_invites_claim_ck check ((redeemed_at is null) = (redeemed_email is null))
);

-- One live link per contractor: making a new one cancels the last.
create unique index if not exists partner_invites_one_open_idx
  on public.partner_invites (partner_id) where redeemed_at is null and revoked_at is null;
create index if not exists partner_invites_farm_idx on public.partner_invites (farm_id, created_at desc);

alter table public.partner_invites enable row level security;
alter table public.partner_invites force row level security;

-- Connecting a contractor is owner and manager business, as on the partners page.
create policy partner_invites_sel on public.partner_invites for select to authenticated
  using (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id)
        and app.effective_farm_role(auth.uid(), farm_id) in ('owner', 'manager'))
  );

-- SECURITY.md 2b. Written by the server after its own checks; the hashes are never readable.
revoke all on public.partner_invites from public, anon, authenticated;
grant select (id, farm_id, partner_id, see_all_vehicles, see_service_history, see_costs, see_team,
              expires_at, failed_attempts, redeemed_at, redeemed_email, revoked_at, created_at)
  on public.partner_invites to authenticated;
grant all on public.partner_invites to service_role;

create trigger partner_invites_audit
  after insert or update or delete on public.partner_invites
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('partner_invites', 'farm', 'who the farm gave access to, and when; the farm''s own decision')
on conflict (table_name) do nothing;

-- What the landing page may say, before anyone has proved anything: the state, and who sent it.
create or replace function public.partner_invite_peek(p_token_hash text)
returns table (state text, farm_name text, business_name text)
language sql stable set search_path = public, pg_temp as $$
  select
    case
      when i.revoked_at is not null or p.deleted_at is not null then 'revoked'
      -- 'claimed' still answers the person who claimed it; 'used' answers nobody.
      when i.redeemed_at is not null and i.expires_at > now() then 'claimed'
      when i.redeemed_at is not null then 'used'
      when i.expires_at <= now() then 'expired'
      when i.failed_attempts >= 5 then 'locked'
      else 'open'
    end,
    f.name,
    p.name
  from public.partner_invites i
  join public.farms f on f.id = i.farm_id
  join public.partners p on p.id = i.partner_id
  where i.token_hash = p_token_hash;
$$;

-- The whole decision, under one row lock. See the header for the rules.
create or replace function public.partner_invite_redeem(p_token_hash text, p_code_hash text, p_email text)
returns table (outcome text, attempts_left integer, invite_id uuid, invite_farm uuid, invite_partner uuid)
language plpgsql set search_path = public, pg_temp as $$
declare
  v       public.partner_invites%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tries integer;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return query select 'bad-email'::text, null::integer, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select * into v from public.partner_invites i where i.token_hash = p_token_hash for update;
  if not found then
    return query select 'invalid'::text, null::integer, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v.revoked_at is not null
     or exists (select 1 from public.partners p where p.id = v.partner_id and p.deleted_at is not null) then
    return query select 'revoked'::text, null::integer, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v.redeemed_at is not null then
    -- Claimed. Only the same person with the same code gets anywhere, and only until it
    -- expires; everybody else hears the same answer whatever they typed.
    if v.redeemed_email = v_email and v.code_hash = p_code_hash and v.expires_at > now() then
      return query select 'again'::text, null::integer, v.id, v.farm_id, v.partner_id;
    else
      return query select 'used'::text, null::integer, null::uuid, null::uuid, null::uuid;
    end if;
    return;
  end if;

  if v.expires_at <= now() then
    return query select 'expired'::text, null::integer, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v.failed_attempts >= 5 then
    return query select 'locked'::text, 0, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v.code_hash <> p_code_hash then
    update public.partner_invites i set failed_attempts = i.failed_attempts + 1
     where i.id = v.id returning i.failed_attempts into v_tries;
    return query select
      case when v_tries >= 5 then 'locked' else 'wrong-code' end::text,
      greatest(5 - v_tries, 0), null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- A farmer's or staff login cannot become a contractor's. Checked before the claim, so a
  -- mistyped address does not spend the link.
  if exists (select 1 from public.users u where lower(u.email) = v_email and u.role <> 'workshop') then
    return query select 'email-taken'::text, null::integer, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  update public.partner_invites i set redeemed_at = now(), redeemed_email = v_email where i.id = v.id;
  return query select 'ok'::text, null::integer, v.id, v.farm_id, v.partner_id;
end $$;

-- Disconnecting ends the link too. Without this, a contractor the farmer had just cut off could
-- type their link and code again within the seven days. Here rather than in the action, so no
-- later way of revoking a link can forget it; definer because the farmer cannot write invites.
create or replace function app.close_invites_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.partner_invites i set revoked_at = now()
    from public.partners p
   where p.id = i.partner_id
     and p.workshop_id = new.workshop_id
     and i.farm_id = new.farm_id
     and i.revoked_at is null;
  return new;
end $$;

revoke all on function app.close_invites_on_disconnect() from public, anon, authenticated;

create trigger workshop_links_close_invites
  after update of status on public.workshop_links
  for each row
  when (new.status = 'revoked' and old.status is distinct from 'revoked')
  execute function app.close_invites_on_disconnect();

revoke all on function public.partner_invite_peek(text) from public, anon, authenticated;
revoke all on function public.partner_invite_redeem(text, text, text) from public, anon, authenticated;
grant execute on function public.partner_invite_peek(text) to service_role;
grant execute on function public.partner_invite_redeem(text, text, text) to service_role;

comment on table public.partner_invites is
  'One-person access links a farmer sends a contractor (20261106110000). Stored as hashes.';
