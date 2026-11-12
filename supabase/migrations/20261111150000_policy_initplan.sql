-- Row-security policies evaluate auth.uid() once per query, not once per row.
--
-- Supabase's advisor (0003_auth_rls_initplan) listed policies whose expression calls
-- auth.uid() or current_setting() directly: Postgres then runs the call for every row it
-- checks. Written as a subselect, (select auth.uid()), it is evaluated once and the result
-- reused. Nothing about who may see or change what moves; the suites prove that.
-- Generated from the live definitions on 2026-11-11 and read through by hand.

alter policy "ai_interactions_sel" on public.ai_interactions
  using (((deleted_at IS NULL) AND (user_id = (select auth.uid())) AND app.has_farm_access(farm_id) AND (app.is_farm_side() OR app.is_rr_admin())));

alter policy "asset_aliases_del" on public.asset_aliases
  using ((app.has_farm_access(farm_id) AND (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role, 'mechanic'::user_role, 'rr_admin'::user_role]))));

alter policy "asset_aliases_ins" on public.asset_aliases
  with check ((app.has_farm_access(farm_id) AND (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role, 'mechanic'::user_role, 'rr_admin'::user_role]))));

alter policy "asset_aliases_upd" on public.asset_aliases
  using ((app.has_farm_access(farm_id) AND (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role, 'mechanic'::user_role, 'rr_admin'::user_role]))))
  with check ((app.has_farm_access(farm_id) AND (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role, 'mechanic'::user_role, 'rr_admin'::user_role]))));

alter policy "asset_positions_sel" on public.asset_positions
  using ((app.is_rr_admin() OR (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role])) OR (EXISTS ( SELECT 1
   FROM driving_sessions s
  WHERE ((s.id = asset_positions.session_id) AND (s.driver_id = (select auth.uid())))))));

alter policy "dashboard_layouts_del" on public.dashboard_layouts
  using ((user_id = (select auth.uid())));

alter policy "dashboard_layouts_ins" on public.dashboard_layouts
  with check (((user_id = (select auth.uid())) AND app.has_farm_access(farm_id)));

alter policy "dashboard_layouts_sel" on public.dashboard_layouts
  using ((user_id = (select auth.uid())));

alter policy "dashboard_layouts_upd" on public.dashboard_layouts
  using ((user_id = (select auth.uid())))
  with check (((user_id = (select auth.uid())) AND app.has_farm_access(farm_id)));

alter policy "driver_credentials_sel" on public.driver_credentials
  using (((deleted_at IS NULL) AND app.has_farm_access(farm_id) AND ((app.current_app_role() = ANY (ARRAY['rr_admin'::user_role, 'owner'::user_role, 'manager'::user_role])) OR (user_id = (select auth.uid())))));

alter policy "farm_ownership_transfers_sel" on public.farm_ownership_transfers
  using ((app.is_rr_admin() OR (from_user = (select auth.uid())) OR (to_user = (select auth.uid()))));

alter policy "job_line_receipt_insert" on public.job_card_line_receipts
  with check (((actor_id = (select auth.uid())) AND app.job_card_worker((select auth.uid()), job_card_id)));

alter policy "job_line_receipt_own" on public.job_card_line_receipts
  using (((actor_id = (select auth.uid())) AND app.job_card_worker((select auth.uid()), job_card_id)));

alter policy "machines_sel" on public.machines
  using ((app.has_farm_access(farm_id) AND (deleted_at IS NULL) AND ((app.effective_farm_role((select auth.uid()), farm_id) IS DISTINCT FROM 'operator'::user_role) OR (assigned_operator_id = (select auth.uid()))) AND app.partner_machine_visible(farm_id, id)));

alter policy "notifications_sel" on public.notifications
  using (((deleted_at IS NULL) AND (app.is_rr_admin() OR (user_id = (select auth.uid())))));

alter policy "notifications_upd" on public.notifications
  using ((app.is_rr_admin() OR (user_id = (select auth.uid()))))
  with check ((app.is_rr_admin() OR (user_id = (select auth.uid()))));

alter policy "partner_documents_sel" on public.partner_documents
  using (((deleted_at IS NULL) AND app.partner_doc_visible(farm_id, workshop_id) AND ((status <> 'draft'::partner_doc_status) OR (workshop_id = app.user_workshop_id()) OR (created_by = (select auth.uid())) OR app.is_rr_admin())));

alter policy "partner_invites_sel" on public.partner_invites
  using ((app.is_rr_admin() OR (app.has_farm_access(farm_id) AND (app.effective_farm_role((select auth.uid()), farm_id) = ANY (ARRAY['owner'::user_role, 'manager'::user_role])))));

alter policy "push_subs_del" on public.push_subscriptions
  using ((user_id = (select auth.uid())));

alter policy "push_subs_ins" on public.push_subscriptions
  with check (((user_id = (select auth.uid())) AND app.has_farm_access(farm_id)));

alter policy "push_subs_sel" on public.push_subscriptions
  using (((user_id = (select auth.uid())) AND (deleted_at IS NULL)));

alter policy "push_subs_upd" on public.push_subscriptions
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));

alter policy "trip_jobs_sel" on public.trip_jobs
  using ((app.trips_office(farm_id) OR (EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = trip_jobs.trip_id) AND (t.driver_id = (select auth.uid())))))));

alter policy "trip_routes_sel" on public.trip_routes
  using ((app.trips_office(farm_id) OR (EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = trip_routes.trip_id) AND (t.driver_id = (select auth.uid())))))));

alter policy "trips_sel" on public.trips
  using ((app.trips_office(farm_id) OR (driver_id = (select auth.uid()))));

alter policy "users_sel" on public.users
  using ((app.is_rr_admin() OR (id = (select auth.uid())) OR ((workshop_id IS NOT NULL) AND (workshop_id = app.user_workshop_id())) OR ((farm_id IS NOT NULL) AND app.has_farm_access(farm_id) AND app.partner_scope(farm_id, 'team'::text))));

alter policy "whatsapp_scope" on public.users
  using (((((select auth.jwt()) ->> 'fw_channel'::text) IS DISTINCT FROM 'whatsapp'::text) OR ((id = (select auth.uid())) AND app.whatsapp_scope((((select auth.jwt()) ->> 'fw_farm_id'::text))::uuid))))
  with check ((((select auth.jwt()) ->> 'fw_channel'::text) IS DISTINCT FROM 'whatsapp'::text));

alter policy "voice_captures_sel" on public.voice_captures
  using (((deleted_at IS NULL) AND (user_id = (select auth.uid())) AND app.has_farm_access(farm_id) AND (app.is_farm_side() OR app.is_rr_admin())));
