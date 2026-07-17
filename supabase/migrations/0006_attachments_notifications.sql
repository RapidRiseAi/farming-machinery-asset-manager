-- 0006_attachments_notifications.sql
-- Polymorphic attachments (photos/docs/invoices/voice) and the notification queue.
-- Attachments are the single canonical store for machine photos/docs, fault photos,
-- job-card photos, etc. (rather than array columns on each table).

create table attachments (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references farms(id),
  parent_type text not null,   -- machine | fault | job_card | job_card_line
  parent_id   uuid not null,
  url         text,
  storage_path text,           -- object path within the Supabase Storage bucket
  kind        attachment_kind not null,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  constraint attachments_parent_type_ck check (parent_type in ('machine','fault','job_card','job_card_line'))
);
create index attachments_farm_idx   on attachments(farm_id);
create index attachments_parent_idx on attachments(parent_type, parent_id);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  farm_id    uuid not null references farms(id),
  user_id    uuid references users(id),
  channel    notification_channel not null,
  template   text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     notification_status not null default 'queued',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid
);
create index notifications_farm_idx   on notifications(farm_id);
create index notifications_user_idx   on notifications(user_id);
create index notifications_status_idx on notifications(status);
