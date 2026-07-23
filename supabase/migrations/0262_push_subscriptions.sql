-- 0262_push_subscriptions.sql
-- Web-Push subscriptions (FR-14.1) — self-hosted VAPID, no external provider.
--
-- One row per browser/device push endpoint a user has granted. The delivery route
-- (service_role) reads these to sign + send VAPID payloads; the browser subscribe/
-- unsubscribe route writes them as the signed-in user. Tenancy carries farm_id (audit +
-- future farm-scoped queries), but RLS here is intentionally STRICTER than the farm-wide
-- default: a user manages only their OWN subscriptions — a manager has no business
-- seeing a colleague's device tokens. service_role bypasses RLS to deliver.

create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null references farms(id),
  user_id      uuid not null references users(id),
  endpoint     text not null,
  p256dh       text not null,          -- client public key (base64url), from the PushSubscription
  auth         text not null,          -- client auth secret (base64url)
  ua           text,                   -- user-agent string, for the "manage devices" UI
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  deleted_at   timestamptz,
  deleted_by   uuid
);
create index push_subscriptions_user_idx on push_subscriptions(user_id) where deleted_at is null;
create index push_subscriptions_farm_idx on push_subscriptions(farm_id);
-- An endpoint is globally unique; one live row per endpoint (resubscribe soft-deletes first).
create unique index push_subscriptions_endpoint_uq on push_subscriptions(endpoint) where deleted_at is null;

-- ── RLS: own-user only ────────────────────────────────────────────
alter table push_subscriptions enable row level security;
alter table push_subscriptions force  row level security;
create policy push_subs_sel on push_subscriptions for select to authenticated
  using (user_id = auth.uid() and deleted_at is null);
create policy push_subs_ins on push_subscriptions for insert to authenticated
  with check (user_id = auth.uid() and app.has_farm_access(farm_id));
create policy push_subs_upd on push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_subs_del on push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on push_subscriptions to authenticated;
grant all on push_subscriptions to service_role;
-- anon gets ZERO access (default privileges in 0102 revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger push_subscriptions_audit
  after insert or update or delete on push_subscriptions
  for each row execute function app_audit();
