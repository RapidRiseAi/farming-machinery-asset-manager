-- Authorize core fleet mutations with the caller's role on EACH ROW'S farm.
--
-- `users.role` / app.current_app_role() describes the primary farm. Multi-site users
-- can be owners on one farm and operators on another, so farm access alone is not enough
-- authorization for writes. These policies deliberately resolve
-- app.effective_farm_role(auth.uid(), farm_id) at the resource boundary.

-- Machines are administered by the selected farm's owner/manager. Meter advances occur
-- through the checked meter-reading command and its SECURITY DEFINER trigger, so normal
-- mechanics/operators never need direct UPDATE permission on arbitrary machine columns.
drop policy if exists machines_ins on public.machines;
drop policy if exists machines_upd on public.machines;
drop policy if exists machines_del on public.machines;
create policy machines_ins on public.machines for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
create policy machines_upd on public.machines for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
create policy machines_del on public.machines for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

-- Readings are operational: operators may record them only against a machine that the
-- assignment/partner visibility helper says they can see. Historical correction and
-- deletion remain owner/manager responsibilities.
drop policy if exists meter_readings_ins on public.meter_readings;
drop policy if exists meter_readings_upd on public.meter_readings;
drop policy if exists meter_readings_del on public.meter_readings;
create policy meter_readings_ins on public.meter_readings for insert to authenticated
  with check (
    app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager','mechanic','operator')
    and app.row_visible_to_role(farm_id, machine_id)
  );
create policy meter_readings_upd on public.meter_readings for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
create policy meter_readings_del on public.meter_readings for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

-- Fault reporting is open to every farm-side role on a visible machine. Lifecycle work
-- requires crew access. A linked workshop remains constrained by the existing partner
-- machine scope rather than being granted whole-farm write access.
drop policy if exists faults_ins on public.faults;
drop policy if exists faults_upd on public.faults;
drop policy if exists faults_del on public.faults;
create policy faults_ins on public.faults for insert to authenticated
  with check (
    app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager','mechanic','operator')
    and app.row_visible_to_role(farm_id, machine_id)
  );
create policy faults_upd on public.faults for update to authenticated
  using (
    (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      and app.row_visible_to_role(farm_id, machine_id)
    )
    or (
      app.current_app_role() = 'workshop'
      and app.has_farm_access(farm_id)
      and app.partner_machine_visible(farm_id, machine_id)
    )
  )
  with check (
    (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      and app.row_visible_to_role(farm_id, machine_id)
    )
    or (
      app.current_app_role() = 'workshop'
      and app.has_farm_access(farm_id)
      and app.partner_machine_visible(farm_id, machine_id)
    )
  );
create policy faults_del on public.faults for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

-- A linked workshop may work only cards on machines inside its granted partner scope.
drop policy if exists job_cards_ins on public.job_cards;
drop policy if exists job_cards_upd on public.job_cards;
drop policy if exists job_cards_del on public.job_cards;
create policy job_cards_ins on public.job_cards for insert to authenticated
  with check (
    status = 'open'
    and locked = false
    and approved_by is null
    and approved_at is null
    and (
      (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        and app.row_visible_to_role(farm_id, machine_id)
      )
      or (
        app.current_app_role() = 'workshop'
        and app.has_farm_access(farm_id)
        and app.partner_machine_visible(farm_id, machine_id)
      )
    )
  );
create policy job_cards_upd on public.job_cards for update to authenticated
  using (
    (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      and app.row_visible_to_role(farm_id, machine_id)
    )
    or (
      app.current_app_role() = 'workshop'
      and app.has_farm_access(farm_id)
      and app.partner_machine_visible(farm_id, machine_id)
    )
  )
  with check (
    (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      and app.row_visible_to_role(farm_id, machine_id)
    )
    or (
      app.current_app_role() = 'workshop'
      and app.has_farm_access(farm_id)
      and app.partner_machine_visible(farm_id, machine_id)
    )
  );
create policy job_cards_del on public.job_cards for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

-- Only an owner/manager on this exact farm may perform the approval transition. The
-- ordinary crew policy above still permits mechanics to edit work before approval.
create or replace function app_guard_jobcard_approval_role() returns trigger
language plpgsql
set search_path = public, app, pg_temp
as $$
declare
  v_role user_role;
begin
  if (
    new.status = 'approved' and old.status is distinct from 'approved'
  ) or new.locked is distinct from old.locked
    or new.approved_by is distinct from old.approved_by
    or new.approved_at is distinct from old.approved_at then
    v_role := app.effective_farm_role(auth.uid(), old.farm_id);
    if v_role is null or v_role not in ('rr_admin','owner','manager') then
      raise exception 'Only this farm''s owner or manager may approve a job card.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function app_guard_jobcard_approval_role()
  from public, anon, authenticated;
drop trigger if exists job_cards_approval_role on public.job_cards;
create trigger job_cards_approval_role
  before update on public.job_cards
  for each row execute function app_guard_jobcard_approval_role();

-- Job-card children inherit authorization from their parent card rather than trusting a
-- farm UUID posted by a form.
drop policy if exists job_card_lines_ins on public.job_card_lines;
drop policy if exists job_card_lines_upd on public.job_card_lines;
drop policy if exists job_card_lines_del on public.job_card_lines;
create policy job_card_lines_ins on public.job_card_lines for insert to authenticated
  with check (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id and jc.deleted_at is null
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ));
create policy job_card_lines_upd on public.job_card_lines for update to authenticated
  using (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id and jc.deleted_at is null
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ))
  with check (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id and jc.deleted_at is null
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ));
create policy job_card_lines_del on public.job_card_lines for delete to authenticated
  using (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ));

drop policy if exists jcsl_ins on public.job_card_service_lines;
drop policy if exists jcsl_del on public.job_card_service_lines;
create policy jcsl_ins on public.job_card_service_lines for insert to authenticated
  with check (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id and jc.deleted_at is null
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ));
create policy jcsl_del on public.job_card_service_lines for delete to authenticated
  using (exists (
    select 1 from public.job_cards jc
    where jc.id = job_card_id and jc.farm_id = farm_id
      and (
        app.effective_farm_role((select auth.uid()), farm_id)
          in ('rr_admin','owner','manager','mechanic')
        or (
          app.current_app_role() = 'workshop'
          and app.partner_machine_visible(farm_id, jc.machine_id)
        )
      )
  ));

-- Fuel administration is owner/manager work. Operational draws are available to a
-- mechanic and to an operator only for an assigned/visible machine.
do $fuel_policies$
declare t text;
begin
  foreach t in array array['fuel_tanks','fuel_deliveries'] loop
    execute format('drop policy if exists %1$I_ins on public.%1$I', t);
    execute format('drop policy if exists %1$I_upd on public.%1$I', t);
    execute format('drop policy if exists %1$I_del on public.%1$I', t);
    execute format(
      'create policy %1$I_ins on public.%1$I for insert to authenticated '
      'with check (app.has_farm_access(farm_id) and '
      'app.effective_farm_role((select auth.uid()), farm_id) in (''rr_admin'',''owner'',''manager''))', t);
    execute format(
      'create policy %1$I_upd on public.%1$I for update to authenticated '
      'using (app.has_farm_access(farm_id) and '
      'app.effective_farm_role((select auth.uid()), farm_id) in (''rr_admin'',''owner'',''manager'')) '
      'with check (app.has_farm_access(farm_id) and '
      'app.effective_farm_role((select auth.uid()), farm_id) in (''rr_admin'',''owner'',''manager''))', t);
    execute format(
      'create policy %1$I_del on public.%1$I for delete to authenticated '
      'using (app.has_farm_access(farm_id) and '
      'app.effective_farm_role((select auth.uid()), farm_id) in (''rr_admin'',''owner'',''manager''))', t);
  end loop;
end $fuel_policies$;

drop policy if exists fuel_issues_ins on public.fuel_issues;
drop policy if exists fuel_issues_upd on public.fuel_issues;
drop policy if exists fuel_issues_del on public.fuel_issues;
create policy fuel_issues_ins on public.fuel_issues for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      or (
        app.effective_farm_role((select auth.uid()), farm_id) = 'operator'
        and machine_id is not null
        and app.row_visible_to_role(farm_id, machine_id)
      )
    )
  );
create policy fuel_issues_upd on public.fuel_issues for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
create policy fuel_issues_del on public.fuel_issues for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

drop policy if exists usage_logs_ins on public.usage_logs;
drop policy if exists usage_logs_upd on public.usage_logs;
drop policy if exists usage_logs_del on public.usage_logs;
create policy usage_logs_ins on public.usage_logs for insert to authenticated
  with check (
    app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager','mechanic','operator')
    and app.row_visible_to_role(farm_id, machine_id)
  );
create policy usage_logs_upd on public.usage_logs for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
create policy usage_logs_del on public.usage_logs for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

-- Operators own the daily meter-capture loop for machines assigned to them. The command
-- already locks the machine, rejects decreasing current/newer readings, validates a
-- driver against this farm, and calls row_visible_to_role (which enforces assignment).
-- Its original role list accidentally excluded operators even though the underlying RLS
-- and product workflow are designed for them.
create or replace function public.record_meter_reading(
  p_farm uuid,
  p_machine uuid,
  p_reading numeric,
  p_reading_date date default current_date,
  p_driver_user uuid default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
  v_driver uuid := auth.uid();
  v_current_reading numeric;
  v_current_date date;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic','operator') then
    raise exception 'This person may not record a meter reading.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if p_reading is null or p_reading < 0 or p_reading > 99999999999.9
     or p_reading_date is null then
    raise exception 'A valid non-negative reading and date are required.'
      using errcode = '22023';
  end if;
  if p_reading_date > current_date then
    raise exception 'A meter reading cannot be dated in the future.'
      using errcode = '22023';
  end if;

  select m.current_reading, m.current_reading_date
    into v_current_reading, v_current_date
    from public.machines m
   where m.id = p_machine
     and m.farm_id = p_farm
     and m.deleted_at is null
     and app.row_visible_to_role(p_farm, p_machine)
   for update;
  if not found then
    raise exception 'Machine not found or not visible to this person.'
      using errcode = '42501';
  end if;
  if v_current_reading is not null
     and v_current_date is not null
     and p_reading_date >= v_current_date
     and p_reading < v_current_reading then
    raise exception 'A current/newer meter reading cannot decrease the machine''s reading.'
      using errcode = '22023';
  end if;

  -- The helper installed by active_farm_member_resolution returns only an access-
  -- scoped boolean. A caller may not SELECT another teammate's membership row.
  if p_driver_user is not null and app.user_belongs_to_farm(p_driver_user, p_farm) then
    v_driver := p_driver_user;
  end if;

  insert into public.meter_readings(
    farm_id, machine_id, reading, reading_date, source, by_user
  ) values (
    p_farm, p_machine, p_reading, p_reading_date, 'manual', auth.uid()
  ) returning id into v_id;

  insert into public.usage_logs(
    farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source
  ) values (
    p_farm, p_machine, v_driver, p_reading_date, p_reading, 'app'
  );

  return v_id;
end $$;

revoke execute on function public.record_meter_reading(uuid, uuid, numeric, date, uuid)
  from public, anon;
grant execute on function public.record_meter_reading(uuid, uuid, numeric, date, uuid)
  to authenticated, service_role;

-- Contractor lifecycle writes are crew work, not merely a consequence of farm access.
-- In particular an owner on Farm A who is an operator on Farm B must not approve or
-- change Farm B contractor amounts. Workshops stay restricted to their own assignments.
drop policy if exists work_requests_ins on public.work_requests;
create policy work_requests_ins on public.work_requests for insert to authenticated
  with check (
    app.row_visible_to_role(farm_id, machine_id)
    and app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager','mechanic')
  );
drop policy if exists work_requests_del on public.work_requests;
create policy work_requests_del on public.work_requests for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager')
  );
drop policy if exists work_requests_upd on public.work_requests;
create policy work_requests_upd on public.work_requests for update to authenticated
  using (
    app.row_visible_to_role(farm_id, machine_id)
    and (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      or (
        app.current_app_role() = 'workshop'
        and workshop_id = app.user_workshop_id()
      )
    )
  )
  with check (
    app.row_visible_to_role(farm_id, machine_id)
    and (
      app.effective_farm_role((select auth.uid()), farm_id)
        in ('rr_admin','owner','manager','mechanic')
      or (
        app.current_app_role() = 'workshop'
        and workshop_id = app.user_workshop_id()
      )
    )
  );

-- Timeline writes inherit the parent's tenant, machine and assigned-workshop boundary.
-- A valid parent UUID is not proof that a caller may append to that request.
drop policy if exists work_request_events_ins on public.work_request_events;
create policy work_request_events_ins on public.work_request_events for insert to authenticated
  with check (exists (
    select 1 from public.work_requests wr
     where wr.id = work_request_events.work_request_id
       and wr.farm_id = work_request_events.farm_id
       and wr.deleted_at is null
       and app.row_visible_to_role(wr.farm_id, wr.machine_id)
       and (
         app.effective_farm_role((select auth.uid()), wr.farm_id)
           in ('rr_admin','owner','manager','mechanic')
         or (app.current_app_role() = 'workshop' and wr.workshop_id = app.user_workshop_id())
       )
  ));
drop policy if exists work_request_events_upd on public.work_request_events;
create policy work_request_events_upd on public.work_request_events for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
    and exists (
      select 1 from public.work_requests wr
       where wr.id = work_request_events.work_request_id
         and wr.farm_id = work_request_events.farm_id and wr.deleted_at is null
    )
  );
drop policy if exists work_request_events_del on public.work_request_events;
create policy work_request_events_del on public.work_request_events for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
