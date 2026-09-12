-- Structured financial privacy without removing the operational record itself.
-- The shared authenticated Postgres role cannot have per-person column grants. Raw
-- amounts therefore lose SELECT privileges; read-only projections return NULL for a
-- caller whose effective role on the resource farm cannot see costs.
--
-- IMPORTANT: these are not postgres-owned views, which would bypass RLS. Their owner
-- is a NOLOGIN / NOBYPASSRLS role that inherits authenticated's existing row policies.
-- Only that role receives the sensitive column grants. No browser/API role may SET
-- ROLE to it. SECURITY BARRIER prevents caller predicates moving below the projection.
-- Existing table INSERT/UPDATE policies are unchanged; clients write base tables and
-- read *_visible. Quantities, service history and fuel consumption remain available.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fleetwise_cost_reader') then
    create role fleetwise_cost_reader nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

-- Notifications retain a snapshot of prices. Re-evaluate disclosure when they are
-- read, including messages addressed to a manager before a role downgrade.
create or replace function app.notification_cost_visible(p_farm uuid, p_template text, p_payload jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_document uuid; v_request uuid;
begin
  if not (
    p_template in ('job_completed','work_request_quoted','work_request_invoiced',
      'partner_quote_received','partner_invoice_received','quote_awaiting','invoice_awaiting',
      'invoice_due_soon','invoice_overdue','invoice_overdue_partner',
      'quote_accepted_partner','payment_claimed_partner')
    or exists (select 1 from pg_catalog.jsonb_object_keys(coalesce(p_payload, '{}'::jsonb)) k
               where k like '%\_cents' escape '\' or k in ('amount','cost','total'))
  ) then return true; end if;
  if app.can_view_farm_costs(p_farm) then return true; end if;
  if app.current_app_role() is distinct from 'workshop' then return false; end if;
  begin
    v_document := nullif(p_payload->>'document_id', '')::uuid;
    v_request := nullif(p_payload->>'work_request_id', '')::uuid;
  exception when invalid_text_representation then return false;
  end;
  return exists (
    select 1 from public.partner_documents d where d.id = v_document
      and d.workshop_id = app.user_workshop_id() and app.partner_doc_visible_by_id(d.id)
  ) or exists (
    select 1 from public.work_requests w where w.id = v_request
      and w.workshop_id = app.user_workshop_id() and app.work_request_visible(w.id)
  );
end $$;
revoke execute on function app.notification_cost_visible(uuid, text, jsonb) from public, anon;
grant execute on function app.notification_cost_visible(uuid, text, jsonb) to authenticated, service_role;
create policy notifications_cost_disclosure on public.notifications
  as restrictive for select to authenticated
  using (app.notification_cost_visible(farm_id, template, payload));

-- A subject-access export must not become a parallel financial-read API after a
-- role change. Keep personal operational history, remove its structured monetary
-- fields and financial attachments/messages when the requester no longer has access.
-- Free-text notes and files are not scanned/redacted by this control.
create or replace function app.redact_export_financials(p_export jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_section text; v_rows jsonb; v_row jsonb; v_farm uuid; v_costs boolean;
begin
  foreach v_section in array array['job_cards','cost_entries_created','attachments_created','notifications'] loop
    v_rows := '[]'::jsonb;
    for v_row in select value from pg_catalog.jsonb_array_elements(coalesce(p_export->v_section, '[]'::jsonb)) loop
      v_farm := nullif(v_row->>'farm_id', '')::uuid;
      v_costs := app.can_view_farm_costs(v_farm);
      if v_section = 'job_cards' and not v_costs then
        v_row := v_row - array['parts_total_cents','labour_total_cents','other_total_cents','total_cents'];
      elsif v_section = 'cost_entries_created' and not v_costs then
        continue;
      elsif v_section = 'attachments_created' and not v_costs
        and (v_row->>'kind' = 'invoice' or
             (v_row->>'parent_type' in ('job_card','work_request') and v_row->>'kind' = 'doc'))
        and not (app.current_app_role() = 'workshop' and v_row->>'parent_type' = 'work_request'
                 and app.work_request_visible((v_row->>'parent_id')::uuid)) then
        continue;
      elsif v_section = 'notifications' and not app.notification_cost_visible(v_farm, v_row->>'template', v_row->'payload') then
        continue;
      end if;
      v_rows := v_rows || pg_catalog.jsonb_build_array(v_row);
    end loop;
    p_export := pg_catalog.jsonb_set(p_export, array[v_section], v_rows);
  end loop;
  return p_export;
end $$;
revoke execute on function app.redact_export_financials(jsonb) from public, anon, authenticated, service_role;

-- Keep the long, independently maintained subject-export implementation and its
-- authorization checks intact. Only wrap its single return; fail the migration if
-- that contract changes, instead of silently losing the new coverage.
do $$ declare v_definition text; begin
  v_definition := pg_catalog.pg_get_functiondef('public.export_personal_data(uuid)'::regprocedure);
  if (length(v_definition) - length(replace(v_definition, 'return v_out;', ''))) / length('return v_out;') <> 1 then
    raise exception 'export_personal_data return contract changed; review financial redaction';
  end if;
  execute replace(v_definition, 'return v_out;', 'return app.redact_export_financials(v_out);');
end $$;
-- Normalise the role, WITHOUT assuming superuser.
--
-- PostgreSQL permits only a SUPERUSER to change the SUPERUSER, REPLICATION and BYPASSRLS
-- attributes — including to CLEAR them — and Supabase's `postgres` role is not a
-- superuser. A bare `alter role … nosuperuser … nobypassrls` therefore fails with
-- "permission denied to alter role" on the only database this has to run on, while passing
-- every local rig, because PGlite and a developer's own Postgres both run as superuser.
-- That is precisely the class of difference a fresh-database harness cannot see, and it is
-- why this was found by dry-running against production rather than by reading.
--
-- Those three are the security-critical attributes: a cost reader that could BYPASSRLS
-- would hand every farm's finances to every caller. So rather than quietly attempting to
-- set them, this REFUSES to go on if they are ever wrong — a migration that stops is far
-- better than a projection layer built on a role that can see through RLS. The attributes a
-- CREATEROLE role may legitimately change are still normalised.
do $role_attributes$
declare r record;
begin
  select rolsuper, rolbypassrls, rolreplication, rolcanlogin, rolinherit,
         rolcreatedb, rolcreaterole
    into r
    from pg_catalog.pg_roles
   where rolname = 'fleetwise_cost_reader';

  if not found then
    raise exception 'fleetwise_cost_reader does not exist';
  end if;

  if r.rolsuper or r.rolbypassrls or r.rolreplication then
    raise exception
      'fleetwise_cost_reader must be NOSUPERUSER, NOBYPASSRLS and NOREPLICATION '
      '(currently super=% bypassrls=% replication=%). It owns the *_visible projections '
      'and is meant to inherit the row policies of authenticated, not to see through '
      'them. Fix it with a superuser role, then re-apply.',
      r.rolsuper, r.rolbypassrls, r.rolreplication;
  end if;

  -- login / inherit / createdb / createrole are alterable by a CREATEROLE role.
  if r.rolcanlogin or not r.rolinherit or r.rolcreatedb or r.rolcreaterole then
    alter role fleetwise_cost_reader nologin inherit nocreatedb nocreaterole;
  end if;
end
$role_attributes$;
grant authenticated to fleetwise_cost_reader;
grant fleetwise_cost_reader to postgres;
grant usage, create on schema public to fleetwise_cost_reader;
grant usage on schema app, auth to fleetwise_cost_reader;

do $projections$
declare
  v_table text;
  v_columns text[];
  v_safe text;
  v_select text;
  v_allowed text;
begin
  for v_table, v_columns in
    select * from (values
      ('job_cards', array['parts_total_cents','labour_total_cents','other_total_cents','total_cents']),
      ('job_card_lines', array['unit_cost_cents','rate_cents','total_cents']),
      ('fuel_deliveries', array['price_per_l_cents','doc_url']),
      ('fuel_issues', array['cost_cents','price_per_l_cents']),
      ('parts_catalogue', array['typical_cost_cents']),
      ('service_kit_items', array['unit_cost_cents']),
      ('stock_movements', array['unit_cost_cents']),
      ('work_requests', array['quote_amount_cents','invoice_amount_cents'])
    ) as protected(table_name, columns)
  loop
    -- A global catalogue price is not a farm's confidential purchase price. A
    -- contractor may still read the quote/invoice they issued on their own request.
    v_allowed := 'app.can_view_farm_costs(t.farm_id)';
    if v_table = 'parts_catalogue' then
      v_allowed := '(t.farm_id is null or app.can_view_farm_costs(t.farm_id))';
    elsif v_table = 'work_requests' then
      v_allowed := '(app.can_view_farm_costs(t.farm_id) or t.workshop_id = app.user_workshop_id())';
    end if;

    select
      string_agg(quote_ident(a.attname), ', ' order by a.attnum)
        filter (where not (a.attname = any(v_columns))),
      string_agg(case when a.attname = any(v_columns)
        then format('case when %s then t.%I else null end as %I', v_allowed, a.attname, a.attname)
        else format('t.%I', a.attname) end, ', ' order by a.attnum)
      into v_safe, v_select
      from pg_attribute a
     where a.attrelid = ('public.' || v_table)::regclass
       and a.attnum > 0 and not a.attisdropped;

    execute format('revoke select on table public.%I from authenticated', v_table);
    execute format('grant select (%s) on table public.%I to authenticated', v_safe, v_table);
    execute format('grant select on table public.%I to fleetwise_cost_reader', v_table);
    execute format('create or replace view public.%I with (security_barrier = true) as select %s from public.%I t', v_table || '_visible', v_select, v_table);
    execute format('alter view public.%I owner to fleetwise_cost_reader', v_table || '_visible');
    execute format('revoke all on public.%I from public, anon, authenticated', v_table || '_visible');
    execute format('grant select on public.%I to authenticated, service_role', v_table || '_visible');
  end loop;
end
$projections$;
revoke create on schema public from fleetwise_cost_reader;

-- A primary owner who is an operator at a second site must not inherit that site's
-- payables. Preserve the existing rule that operators cannot read partner documents,
-- even when operational cost display is opted in; use the resource-farm role.
create or replace function app.partner_doc_visible(p_farm uuid, p_workshop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
    and (
      app.is_rr_admin()
      or (app.current_app_role() = 'workshop' and p_workshop = app.user_workshop_id())
      or app.effective_farm_role(auth.uid(), p_farm) in ('owner','manager','mechanic')
    );
$$;

-- Known financial files are protected too. Quotes are stored as kind=doc on a work
-- request; invoices have their own kind. This does not scan ordinary photos or notes.
create policy attachments_cost_disclosure on public.attachments
  as restrictive for select to authenticated
  using (
    (kind <> 'invoice' and not (parent_type in ('work_request','job_card') and kind = 'doc'))
    or app.can_view_farm_costs(farm_id)
    or (app.current_app_role() = 'workshop' and parent_type = 'work_request'
        and app.work_request_visible(parent_id))
  );

-- Storage has its own API: hiding attachment rows is insufficient if a caller knows
-- the object key. Add a restrictive READ-only guard, leaving upload policies intact.
-- No storage schema exists in some bare-Postgres test environments.
create or replace function app.storage_cost_visible(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_farm uuid; v_parent uuid;
begin
  begin
    v_farm := nullif(split_part(p_name, '/', 1), '')::uuid;
    v_parent := nullif(split_part(p_name, '/', 2), '')::uuid;
  exception when invalid_text_representation then return false;
  end;
  if p_bucket = 'partner-docs' then
    return app.partner_doc_visible_by_id(v_parent);
  end if;
  if p_bucket not in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos') then
    return true;
  end if;
  if app.can_view_farm_costs(v_farm) then return true; end if;
  return not exists (
    select 1 from public.attachments a
     where a.farm_id = v_farm and a.storage_path = p_name
       and (a.kind = 'invoice' or (a.parent_type in ('work_request','job_card') and a.kind = 'doc'))
       and not (app.current_app_role() = 'workshop' and a.parent_type = 'work_request'
                and app.work_request_visible(a.parent_id))
  );
end $$;
revoke execute on function app.storage_cost_visible(text, text) from public, anon;
grant execute on function app.storage_cost_visible(text, text) to authenticated, service_role;
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'create policy "financial objects disclosure" on storage.objects as restrictive for select to authenticated using (app.storage_cost_visible(bucket_id, name))';
  end if;
end $$;
