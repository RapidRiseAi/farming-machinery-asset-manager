-- Make every newly introduced administrative surface use the caller's role on the
-- selected farm. A primary-farm owner can be an operator on another farm (and vice
-- versa); app.current_app_role() cannot safely authorize a row whose farm_id differs
-- from users.farm_id.

-- -----------------------------------------------------------------------------
-- Scheduled reports (0506)
-- -----------------------------------------------------------------------------

drop policy if exists report_schedules_sel on public.report_schedules;
drop policy if exists report_schedules_ins on public.report_schedules;
drop policy if exists report_schedules_upd on public.report_schedules;
drop policy if exists report_schedules_del on public.report_schedules;

create policy report_schedules_sel on public.report_schedules
  for select to authenticated
  using (
    deleted_at is null
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy report_schedules_ins on public.report_schedules
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedules_upd on public.report_schedules
  for update to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  )
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedules_del on public.report_schedules
  for delete to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );

drop policy if exists report_schedule_recipients_sel on public.report_schedule_recipients;
drop policy if exists report_schedule_recipients_ins on public.report_schedule_recipients;
drop policy if exists report_schedule_recipients_upd on public.report_schedule_recipients;
drop policy if exists report_schedule_recipients_del on public.report_schedule_recipients;

create policy report_schedule_recipients_sel on public.report_schedule_recipients
  for select to authenticated
  using (
    deleted_at is null
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy report_schedule_recipients_ins on public.report_schedule_recipients
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedule_recipients_upd on public.report_schedule_recipients
  for update to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  )
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedule_recipients_del on public.report_schedule_recipients
  for delete to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );

drop policy if exists report_schedule_runs_sel on public.report_schedule_runs;
drop policy if exists report_schedule_runs_ins on public.report_schedule_runs;
drop policy if exists report_schedule_runs_upd on public.report_schedule_runs;
drop policy if exists report_schedule_runs_del on public.report_schedule_runs;

create policy report_schedule_runs_sel on public.report_schedule_runs
  for select to authenticated
  using (
    deleted_at is null
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy report_schedule_runs_ins on public.report_schedule_runs
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedule_runs_upd on public.report_schedule_runs
  for update to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  )
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy report_schedule_runs_del on public.report_schedule_runs
  for delete to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );

create or replace function public.run_report_schedule(p_id uuid)
returns table (
  run_id           uuid,
  schedule_id      uuid,
  farm_id          uuid,
  farm_name        text,
  schedule_name    text,
  report_key       report_family,
  output_format    report_format,
  lang             app_language,
  period_start     date,
  period_end       date,
  include_inactive boolean,
  site             text,
  recipients       text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farm uuid;
  v_role public.user_role;
begin
  select s.farm_id
    into v_farm
    from public.report_schedules s
   where s.id = p_id
     and s.deleted_at is null;

  if v_farm is null then
    raise exception 'schedule not found' using errcode = 'P0002';
  end if;

  if not app.is_rr_admin() then
    v_role := app.effective_farm_role(auth.uid(), v_farm);
    if v_role is distinct from 'owner' and v_role is distinct from 'manager' then
      raise exception 'That schedule belongs to another farm.' using errcode = '42501';
    end if;
  end if;

  return query
    select * from app.run_due_report_schedules(p_id, null);
end;
$$;

revoke execute on function public.run_report_schedule(uuid) from public, anon;
grant execute on function public.run_report_schedule(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Per-user permission grants (0507)
-- -----------------------------------------------------------------------------

-- Tighten the profile table to the same selected-farm rule. Self-service profile edits
-- remain available, while another person's row requires owner/manager authority on that
-- person's primary farm. The trigger independently protects administrative columns.
drop policy if exists users_ins on public.users;
drop policy if exists users_upd on public.users;

create policy users_ins on public.users
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy users_upd on public.users
  for update to authenticated
  using (
    id = (select auth.uid())
    or app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  )
  with check (
    id = (select auth.uid())
    or app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );

create or replace function public.app_users_guard_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_change boolean;
  v_old_role public.user_role;
  v_new_role public.user_role;
begin
  v_admin_change :=
       new.role is distinct from old.role
    or new.farm_id is distinct from old.farm_id
    or new.workshop_id is distinct from old.workshop_id
    or new.active is distinct from old.active
    or new.deleted_at is distinct from old.deleted_at;

  if not v_admin_change or auth.uid() is null or app.is_rr_admin() then
    return new;
  end if;

  if old.id = auth.uid() then
    raise exception 'You cannot change your own role, farm or account status.'
      using errcode = '42501';
  end if;

  if old.farm_id is null then
    raise exception 'Only Rapid Rise can change this account access.'
      using errcode = '42501';
  end if;
  v_old_role := app.effective_farm_role(auth.uid(), old.farm_id);
  if v_old_role is distinct from 'owner' and v_old_role is distinct from 'manager' then
    raise exception 'Only an owner or manager of this person''s farm can change their access.'
      using errcode = '42501';
  end if;

  if new.role = 'rr_admin' then
    raise exception 'Only Rapid Rise can create a Rapid Rise administrator.'
      using errcode = '42501';
  end if;

  if new.workshop_id is distinct from old.workshop_id then
    raise exception 'A partner account is created by the invite flow, not by editing a person.'
      using errcode = '42501';
  end if;

  if new.farm_id is distinct from old.farm_id then
    if new.farm_id is null then
      raise exception 'You cannot remove a person from every farm.' using errcode = '42501';
    end if;
    v_new_role := app.effective_farm_role(auth.uid(), new.farm_id);
    if v_new_role is distinct from 'owner' and v_new_role is distinct from 'manager' then
      raise exception 'You cannot move someone to a farm you do not administer.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.app_users_guard_privileges()
  from public, anon, authenticated;

-- The membership table is itself an administrative surface. Keep own-row discovery,
-- but never let a person write their own membership (which would let a manager turn
-- themselves into an owner). Every administrative decision uses the role on that row's
-- farm rather than the profile role from a different farm.
drop policy if exists ufm_sel on public.user_farm_memberships;
drop policy if exists ufm_ins on public.user_farm_memberships;
drop policy if exists ufm_upd on public.user_farm_memberships;
drop policy if exists ufm_del on public.user_farm_memberships;

create policy ufm_sel on public.user_farm_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (
      user_id = (select auth.uid())
      or app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy ufm_ins on public.user_farm_memberships
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or (
      user_id <> (select auth.uid())
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy ufm_upd on public.user_farm_memberships
  for update to authenticated
  using (
    app.is_rr_admin()
    or (
      user_id <> (select auth.uid())
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  )
  with check (
    app.is_rr_admin()
    or (
      user_id <> (select auth.uid())
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy ufm_del on public.user_farm_memberships
  for delete to authenticated
  using (
    app.is_rr_admin()
    or (
      user_id <> (select auth.uid())
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );

drop policy if exists upg_sel on public.user_permission_grants;
drop policy if exists upg_ins on public.user_permission_grants;
drop policy if exists upg_upd on public.user_permission_grants;
drop policy if exists upg_del on public.user_permission_grants;

create policy upg_sel on public.user_permission_grants
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and deleted_at is null)
    or app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy upg_ins on public.user_permission_grants
  for insert to authenticated
  with check (
    user_id <> (select auth.uid())
    and app.user_belongs_to_farm(user_id, farm_id)
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy upg_upd on public.user_permission_grants
  for update to authenticated
  using (
    user_id <> (select auth.uid())
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  )
  with check (
    user_id <> (select auth.uid())
    and app.user_belongs_to_farm(user_id, farm_id)
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy upg_del on public.user_permission_grants
  for delete to authenticated
  using (
    user_id <> (select auth.uid())
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );

-- The baseline write policies opened by 0507's additive grants predate selected-farm
-- roles. Correct the baseline too, otherwise a primary owner could still write stock on
-- a farm where they are only an operator, while a secondary owner could not manage that
-- farm's own partner directory.
drop policy if exists stock_items_ins on public.stock_items;
drop policy if exists stock_items_upd on public.stock_items;
drop policy if exists stock_items_del on public.stock_items;

create policy stock_items_ins on public.stock_items
  for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );
create policy stock_items_upd on public.stock_items
  for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );
create policy stock_items_del on public.stock_items
  for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );

drop policy if exists stock_movements_ins on public.stock_movements;
drop policy if exists stock_movements_upd on public.stock_movements;
drop policy if exists stock_movements_del on public.stock_movements;

create policy stock_movements_ins on public.stock_movements
  for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );
create policy stock_movements_upd on public.stock_movements
  for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );
create policy stock_movements_del on public.stock_movements
  for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.is_farm_side()
    and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
  );

drop policy if exists partners_ins on public.partners;
drop policy if exists partners_upd on public.partners;
drop policy if exists partners_del on public.partners;

create policy partners_ins on public.partners
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy partners_upd on public.partners
  for update to authenticated
  using (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  )
  with check (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy partners_del on public.partners
  for delete to authenticated
  using (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );

-- The farm-owned parts catalogue predates multi-farm memberships and originally
-- trusted only users.farm_id. Keep global catalogue rows RR-admin managed, while
-- authorizing farm rows from the caller's effective role on that specific farm.
drop policy if exists parts_catalogue_ins on public.parts_catalogue;
drop policy if exists parts_catalogue_upd on public.parts_catalogue;
drop policy if exists parts_catalogue_del on public.parts_catalogue;

create policy parts_catalogue_ins on public.parts_catalogue
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.has_farm_access(farm_id)
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
    )
  );
create policy parts_catalogue_upd on public.parts_catalogue
  for update to authenticated
  using (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.has_farm_access(farm_id)
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
    )
  )
  with check (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.has_farm_access(farm_id)
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
    )
  );
create policy parts_catalogue_del on public.parts_catalogue
  for delete to authenticated
  using (
    app.is_rr_admin()
    or (
      farm_id is not null
      and app.has_farm_access(farm_id)
      and app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager', 'mechanic')
    )
  );

-- -----------------------------------------------------------------------------
-- Public API credentials (0508)
-- -----------------------------------------------------------------------------

drop policy if exists api_tokens_sel on public.api_tokens;
drop policy if exists api_tokens_ins on public.api_tokens;
drop policy if exists api_tokens_upd on public.api_tokens;
drop policy if exists api_tokens_del on public.api_tokens;

create policy api_tokens_sel on public.api_tokens
  for select to authenticated
  using (
    deleted_at is null
    and (
      app.is_rr_admin()
      or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
    )
  );
create policy api_tokens_ins on public.api_tokens
  for insert to authenticated
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy api_tokens_upd on public.api_tokens
  for update to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  )
  with check (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );
create policy api_tokens_del on public.api_tokens
  for delete to authenticated
  using (
    app.is_rr_admin()
    or app.effective_farm_role((select auth.uid()), farm_id) in ('owner', 'manager')
  );

comment on function public.run_report_schedule(uuid) is
  'Claim a due report schedule after authorizing the caller against the schedule farm role.';
