-- 20261105120000_dashboard_layouts.sql
-- Each person's own dashboard board, per farm (the customisable dashboard).
--
-- A preference, not a farm record. RLS is own-row only, stricter than the farm default
-- the way push_subscriptions (0262) is: a manager has no business rearranging a
-- colleague's board. A row may only be written for a farm the person can reach. No
-- audit trigger: every drag saves one, and the row records no business fact. Fenced like
-- every row that ties a person to a farm (20261014120000).
--
-- The app validates the layout (lib/dashboard/schema.ts) before writing it and again
-- after reading it; the checks here only bound its shape and size.

create table if not exists public.dashboard_layouts (
  user_id    uuid not null references public.users(id) on delete cascade,
  farm_id    uuid not null references public.farms(id) on delete cascade,
  layout     jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, farm_id),
  -- coalesce: a missing `items` makes jsonb_typeof null, and a null CHECK passes.
  constraint dashboard_layouts_shape_ck
    check (coalesce(jsonb_typeof(layout) = 'object' and jsonb_typeof(layout -> 'items') = 'array', false)),
  constraint dashboard_layouts_size_ck check (octet_length(layout::text) <= 24000)
);
create index if not exists dashboard_layouts_farm_idx on public.dashboard_layouts (farm_id);

alter table public.dashboard_layouts enable row level security;
alter table public.dashboard_layouts force row level security;

create policy dashboard_layouts_sel on public.dashboard_layouts for select to authenticated
  using (user_id = auth.uid());
create policy dashboard_layouts_ins on public.dashboard_layouts for insert to authenticated
  with check (user_id = auth.uid() and app.has_farm_access(farm_id));
create policy dashboard_layouts_upd on public.dashboard_layouts for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and app.has_farm_access(farm_id));
create policy dashboard_layouts_del on public.dashboard_layouts for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.dashboard_layouts from public, anon;
grant select, insert, update, delete on public.dashboard_layouts to authenticated;
grant all on public.dashboard_layouts to service_role;

create trigger dashboard_layouts_test_fence before insert or update on public.dashboard_layouts
  for each row execute function app.fence_user_farm();
