-- 0101_rls_policies.sql
-- Enable + FORCE row-level security on every table and define policies.
-- Cross-tenant + external-workshop isolation is guaranteed here and proven by
-- supabase/tests/rls_isolation.sql. Intra-farm role nuance (operator submit-only,
-- cost visibility, etc.) is layered on top in later phases.

-- ── Standard farm-scoped tables ──────────────────────────────────
-- Every one has a farm_id; access == app.has_farm_access(farm_id); reads also
-- hide soft-deleted rows.
do $do$
declare t text;
begin
  foreach t in array array[
    'machines','meter_readings','service_plan_lines','faults','job_cards',
    'job_card_lines','watch_items','attachments','notifications',
    'fuel_tanks','fuel_deliveries','fuel_issues'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (app.has_farm_access(farm_id) and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.has_farm_access(farm_id))', t);
  end loop;
end $do$;

-- ── farms ────────────────────────────────────────────────────────
alter table farms enable row level security;
alter table farms force  row level security;
create policy farms_sel on farms for select to authenticated
  using (app.has_farm_access(id) and deleted_at is null);
create policy farms_ins on farms for insert to authenticated
  with check (app.is_rr_admin());
create policy farms_upd on farms for update to authenticated
  using (app.is_rr_admin()) with check (app.is_rr_admin());
create policy farms_del on farms for delete to authenticated
  using (app.is_rr_admin());

-- ── users ────────────────────────────────────────────────────────
-- You can always see yourself; RR admin sees all; farm members see co-members;
-- workshop staff see their own workshop's members.
alter table users enable row level security;
alter table users force  row level security;
create policy users_sel on users for select to authenticated
  using (
    id = auth.uid()
    or app.is_rr_admin()
    or (farm_id is not null and app.has_farm_access(farm_id))
    or (workshop_id is not null and workshop_id = app.user_workshop_id())
  );
create policy users_ins on users for insert to authenticated
  with check (app.is_rr_admin() or (farm_id is not null and app.has_farm_access(farm_id)));
create policy users_upd on users for update to authenticated
  using (id = auth.uid() or app.is_rr_admin() or (farm_id is not null and app.has_farm_access(farm_id)))
  with check (id = auth.uid() or app.is_rr_admin() or (farm_id is not null and app.has_farm_access(farm_id)));
create policy users_del on users for delete to authenticated
  using (app.is_rr_admin());

-- ── workshops ────────────────────────────────────────────────────
alter table workshops enable row level security;
alter table workshops force  row level security;
create policy workshops_sel on workshops for select to authenticated
  using (
    app.is_rr_admin()
    or id = app.user_workshop_id()
    or id in (
      select wl.workshop_id from workshop_links wl
      where app.has_farm_access(wl.farm_id) and wl.status = 'active' and wl.deleted_at is null
    )
  );
create policy workshops_ins on workshops for insert to authenticated with check (app.is_rr_admin());
create policy workshops_upd on workshops for update to authenticated using (app.is_rr_admin()) with check (app.is_rr_admin());
create policy workshops_del on workshops for delete to authenticated using (app.is_rr_admin());

-- ── workshop_links ───────────────────────────────────────────────
-- Visible to RR admin, the linked workshop's staff, and the farm side.
-- Mutable only by RR admin or a member of the farm (never by the workshop itself).
alter table workshop_links enable row level security;
alter table workshop_links force  row level security;
create policy wl_sel on workshop_links for select to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id() or app.has_farm_access(farm_id));
create policy wl_ins on workshop_links for insert to authenticated
  with check (app.is_rr_admin() or app.user_farm_id() = farm_id);
create policy wl_upd on workshop_links for update to authenticated
  using (app.is_rr_admin() or app.user_farm_id() = farm_id)
  with check (app.is_rr_admin() or app.user_farm_id() = farm_id);
create policy wl_del on workshop_links for delete to authenticated
  using (app.is_rr_admin() or app.user_farm_id() = farm_id);

-- ── service_templates ────────────────────────────────────────────
-- Global templates (farm_id null) are readable by all authenticated users;
-- per-farm templates follow farm access. Mutation is RR admin (global) or the
-- owning farm's members.
alter table service_templates enable row level security;
alter table service_templates force  row level security;
create policy st_sel on service_templates for select to authenticated
  using ((farm_id is null or app.has_farm_access(farm_id)) and deleted_at is null);
create policy st_ins on service_templates for insert to authenticated
  with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));
create policy st_upd on service_templates for update to authenticated
  using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id))
  with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));
create policy st_del on service_templates for delete to authenticated
  using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));

-- ── audit_log ────────────────────────────────────────────────────
-- Read-only to clients (farm-scoped); rows are written only by the SECURITY DEFINER
-- audit trigger, which bypasses RLS. No insert/update/delete policies exist, so with
-- FORCE RLS clients cannot write it.
alter table audit_log enable row level security;
alter table audit_log force  row level security;
create policy audit_sel on audit_log for select to authenticated
  using (app.is_rr_admin() or (farm_id is not null and app.has_farm_access(farm_id)));
