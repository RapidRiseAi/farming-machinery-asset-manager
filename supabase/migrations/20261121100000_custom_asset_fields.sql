-- 20261121100000_custom_asset_fields.sql
-- Task B5: customer-defined asset fields on Professional and Complete (BRIEF section 17).
--
-- A business defines typed fields (text, number with an optional unit, date, yes/no, choice),
-- with visibility, a group, an order and a "required" flag; renames them and retires them
-- without losing a single value; every change is in the audit log. Values are data: stored in
-- typed columns, never interpreted as SQL or markup, and they never touch an asset's billing
-- profile or any trip, fuel, finance or depreciation engine. Support equipment may use them.
-- The plan placement (Professional) is the earlier feature map's implementation default, not a
-- separately ratified price; no new fee.
--
-- Additive: two new tables and functions; app.feature_min_rank gains custom_fields (2).

-- == The plan rank, with custom fields on Professional ========================================
create or replace function app.feature_min_rank(p_feature text) returns int
language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_feature
    when 'dashboard'           then 2
    when 'advanced_reports'    then 2
    when 'fuel'                then 2
    when 'tco'                 then 2
    when 'budgets'             then 2
    when 'depreciation'        then 2
    when 'trips'               then 2
    when 'custom_fields'       then 2
    when 'maps'                then 3
    when 'aarto'               then 3
    when 'voice_ai'            then 3
    when 'multi_site'          then 3
    when 'whatsapp'            then 3
    when 'api_access'          then 4
    when 'driving_log'         then 1
    when 'driver_workflow'     then 1
    when 'road_licensing'      then 1
    when 'finance_agreements'  then 1
    when 'tyre_detail'         then 1
    when 'sale_warranty_packs' then 1
    when 'general_chat'        then 1
    else 1
  end;
$$;

-- == Tables ====================================================================================
create table if not exists public.asset_field_definitions (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.farms(id),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null check (char_length(btrim(label)) between 1 and 60 and label !~ '[<>[:cntrl:]]'),
  field_type  text not null check (field_type in ('text', 'number', 'date', 'yes_no', 'choice')),
  unit        text check (unit is null or (char_length(btrim(unit)) between 1 and 16 and unit !~ '[<>[:cntrl:]]')),
  choices     text[] not null default '{}' check (cardinality(choices) <= 30),
  required    boolean not null default false,
  visibility  text not null default 'everyone' check (visibility in ('everyone', 'managers')),
  group_label text check (group_label is null or (char_length(btrim(group_label)) between 1 and 40 and group_label !~ '[<>[:cntrl:]]')),
  sort_order  integer not null default 0 check (sort_order between 0 and 10000),
  retired_at  timestamptz,
  created_by  uuid references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint asset_field_definitions_key_uq unique (farm_id, key),
  constraint asset_field_definitions_id_farm_uq unique (id, farm_id),
  constraint asset_field_definitions_choices_ck check ((field_type = 'choice') = (cardinality(choices) > 0)),
  constraint asset_field_definitions_unit_ck check (unit is null or field_type = 'number')
);

create table if not exists public.asset_field_values (
  machine_id    uuid not null,
  farm_id       uuid not null,
  definition_id uuid not null,
  value_text    text check (value_text is null or char_length(value_text) <= 500),
  value_number  numeric check (value_number is null or value_number between -1000000000000 and 1000000000000),
  value_date    date,
  value_bool    boolean,
  updated_by    uuid references public.users(id),
  updated_at    timestamptz not null default now(),
  primary key (machine_id, definition_id),
  foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  foreign key (definition_id, farm_id) references public.asset_field_definitions(id, farm_id),
  constraint asset_field_values_one_ck check (num_nonnulls(value_text, value_number, value_date, value_bool) = 1)
);
create index if not exists asset_field_values_farm on public.asset_field_values (farm_id);

do $$ declare t text; begin
  foreach t in array array['asset_field_definitions', 'asset_field_values'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.app_audit()', t || '_audit', t);
  end loop;
end $$;

-- Who may see a field: everyone on the business, or owners and managers for a "managers" field.
create or replace function app.asset_field_visible(p_farm uuid, p_visibility text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
     and (p_visibility = 'everyone'
          or app.effective_farm_role((select auth.uid()), p_farm) in ('rr_admin', 'owner', 'manager'));
$$;
revoke all on function app.asset_field_visible(uuid, text) from public, anon;
grant execute on function app.asset_field_visible(uuid, text) to authenticated;

drop policy if exists asset_field_definitions_sel on public.asset_field_definitions;
create policy asset_field_definitions_sel on public.asset_field_definitions for select to authenticated
  using (app.asset_field_visible(farm_id, visibility));
drop policy if exists asset_field_values_sel on public.asset_field_values;
create policy asset_field_values_sel on public.asset_field_values for select to authenticated
  using (exists (select 1 from public.asset_field_definitions d
                  where d.id = definition_id and app.asset_field_visible(d.farm_id, d.visibility)));
select app.pay_gate_apply('asset_field_definitions');
select app.pay_gate_apply('asset_field_values');

-- == Writing (owners and managers; Rapid Rise during a support visit) ==========================
create or replace function app.asset_field_writer(p_farm uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.has_farm_access(p_farm)
     or coalesce(app.effective_farm_role((select auth.uid()), p_farm)::text, '') not in ('rr_admin', 'owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not app.farm_plan_allows(p_farm, 'custom_fields') then
    raise exception 'plan-feature-custom_fields' using errcode = '42501';
  end if;
end $$;
revoke all on function app.asset_field_writer(uuid) from public, anon, authenticated;

-- Labels, units, groups and choices are plain words: trimmed, bounded, no markup, no controls.
create or replace function app.asset_field_clean(p_text text, p_max integer) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare v text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if v is null then return null; end if;
  if char_length(v) > p_max or v ~ '[<>[:cntrl:]]' then raise exception 'custom-field-invalid' using errcode = '22023'; end if;
  return v;
end $$;
revoke all on function app.asset_field_clean(text, integer) from public, anon, authenticated;

create or replace function public.asset_field_define(
  p_farm uuid, p_label text, p_type text, p_unit text default null, p_choices text[] default '{}',
  p_required boolean default false, p_visibility text default 'everyone', p_group text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_label text := app.asset_field_clean(p_label, 60);
  v_base text;
  v_key text;
  v_n integer := 1;
  v_choices text[];
  v_id uuid;
begin
  perform app.asset_field_writer(p_farm);
  perform app.require_open_farm(p_farm, true);
  if v_label is null or p_type not in ('text', 'number', 'date', 'yes_no', 'choice')
     or p_visibility not in ('everyone', 'managers') then
    raise exception 'custom-field-invalid' using errcode = '22023';
  end if;
  if (select count(*) from public.asset_field_definitions where farm_id = p_farm and retired_at is null) >= 50 then
    raise exception 'custom-field-limit' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct app.asset_field_clean(c, 60)) filter (where nullif(btrim(c), '') is not null), '{}')
    into v_choices from unnest(coalesce(p_choices, '{}')) c;
  -- The key is chosen here from the label, never from the caller: lower-case letters, digits, _.
  v_base := left(regexp_replace(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g'), 32);
  if v_base !~ '^[a-z]' then v_base := 'f_' || v_base; end if;
  v_base := left(v_base, 32);
  v_key := v_base;
  while exists (select 1 from public.asset_field_definitions where farm_id = p_farm and key = v_key) loop
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  end loop;
  insert into public.asset_field_definitions (farm_id, key, label, field_type, unit, choices, required, visibility, group_label, sort_order, created_by)
  values (p_farm, v_key, v_label, p_type,
          case when p_type = 'number' then app.asset_field_clean(p_unit, 16) end,
          case when p_type = 'choice' then v_choices else '{}' end,
          coalesce(p_required, false), p_visibility, app.asset_field_clean(p_group, 40),
          coalesce((select max(sort_order) + 10 from public.asset_field_definitions where farm_id = p_farm), 0),
          auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Rename, regroup, reorder, change visibility, required or the choices; never the type, which
-- would strand the values already kept.
create or replace function public.asset_field_update(
  p_definition uuid, p_label text, p_unit text default null, p_choices text[] default null,
  p_required boolean default null, p_visibility text default null, p_group text default null, p_sort integer default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d public.asset_field_definitions;
  v_choices text[];
begin
  select * into d from public.asset_field_definitions where id = p_definition for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.asset_field_writer(d.farm_id);
  perform app.require_open_farm(d.farm_id, true);
  if p_visibility is not null and p_visibility not in ('everyone', 'managers') then
    raise exception 'custom-field-invalid' using errcode = '22023';
  end if;
  if p_choices is not null and d.field_type = 'choice' then
    select coalesce(array_agg(distinct app.asset_field_clean(c, 60)) filter (where nullif(btrim(c), '') is not null), '{}')
      into v_choices from unnest(p_choices) c;
    if cardinality(v_choices) = 0 then raise exception 'custom-field-invalid' using errcode = '22023'; end if;
    -- A choice still used by an asset stays: removing it would make a kept value invalid.
    if exists (select 1 from public.asset_field_values v where v.definition_id = d.id and not (v.value_text = any (v_choices))) then
      raise exception 'custom-field-choice-in-use' using errcode = '22023';
    end if;
  end if;
  update public.asset_field_definitions set
    label = coalesce(app.asset_field_clean(p_label, 60), label),
    unit = case when field_type = 'number' then coalesce(app.asset_field_clean(p_unit, 16), unit) else null end,
    choices = coalesce(v_choices, choices),
    required = coalesce(p_required, required),
    visibility = coalesce(p_visibility, visibility),
    group_label = case when p_group is null then group_label else app.asset_field_clean(p_group, 40) end,
    sort_order = coalesce(p_sort, sort_order),
    updated_at = now()
  where id = d.id;
end $$;

-- Retire (or bring back): the definition and every value stay; a retired field takes no new values.
create or replace function public.asset_field_retire(p_definition uuid, p_retire boolean default true) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.asset_field_definitions;
begin
  select * into d from public.asset_field_definitions where id = p_definition for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.asset_field_writer(d.farm_id);
  perform app.require_open_farm(d.farm_id, true);
  update public.asset_field_definitions
     set retired_at = case when p_retire then coalesce(retired_at, now()) end, updated_at = now()
   where id = d.id;
end $$;

-- One asset's values: {"<definition id>": value or null}. Each is checked against its type; a
-- null clears it (refused for a required field). Values are stored as data in typed columns.
create or replace function public.asset_field_set(p_machine uuid, p_values jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m record;
  d public.asset_field_definitions;
  r record;
  v jsonb;
  v_text text; v_num numeric; v_date date; v_bool boolean;
  v_n integer := 0;
begin
  select id, farm_id into m from public.machines where id = p_machine and deleted_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.asset_field_writer(m.farm_id);
  perform app.require_open_farm(m.farm_id, true);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'custom-field-invalid' using errcode = '22023'; end if;
  for r in select key, value from jsonb_each(p_values) loop
    select * into d from public.asset_field_definitions
     where id::text = r.key and farm_id = m.farm_id;
    -- Another business's field, or one that does not exist: refused, never created.
    if not found then raise exception 'forbidden' using errcode = '42501'; end if;
    v := r.value;
    if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') then
      if d.required then raise exception 'custom-field-required' using errcode = '22023'; end if;
      delete from public.asset_field_values where machine_id = m.id and definition_id = d.id;
      v_n := v_n + 1;
      continue;
    end if;
    if d.retired_at is not null then raise exception 'custom-field-retired' using errcode = '22023'; end if;
    v_text := null; v_num := null; v_date := null; v_bool := null;
    begin
      case d.field_type
        when 'text' then
          v_text := btrim(v #>> '{}');
          if char_length(v_text) > 500 or v_text ~ '[[:cntrl:]]' then raise exception 'bad'; end if;
        when 'number' then
          v_num := (v #>> '{}')::numeric;
          if v_num is null or v_num::text in ('NaN', 'Infinity', '-Infinity') or abs(v_num) > 1000000000000 then raise exception 'bad'; end if;
        when 'date' then
          if (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
          v_date := (v #>> '{}')::date;
          if v_date < date '1900-01-01' or v_date > date '2200-12-31' then raise exception 'bad'; end if;
        when 'yes_no' then
          if jsonb_typeof(v) <> 'boolean' then raise exception 'bad'; end if;
          v_bool := (v #>> '{}')::boolean;
        when 'choice' then
          v_text := btrim(v #>> '{}');
          if not (v_text = any (d.choices)) then raise exception 'bad'; end if;
      end case;
    exception when others then
      raise exception 'custom-field-invalid' using errcode = '22023', detail = d.key;
    end;
    insert into public.asset_field_values (machine_id, farm_id, definition_id, value_text, value_number, value_date, value_bool, updated_by, updated_at)
    values (m.id, m.farm_id, d.id, v_text, v_num, v_date, v_bool, auth.uid(), now())
    on conflict (machine_id, definition_id) do update set
      value_text = excluded.value_text, value_number = excluded.value_number, value_date = excluded.value_date,
      value_bool = excluded.value_bool, updated_by = excluded.updated_by, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.asset_field_define(uuid, text, text, text, text[], boolean, text, text) from public, anon;
revoke all on function public.asset_field_update(uuid, text, text, text[], boolean, text, text, integer) from public, anon;
revoke all on function public.asset_field_retire(uuid, boolean) from public, anon;
revoke all on function public.asset_field_set(uuid, jsonb) from public, anon;
grant execute on function public.asset_field_define(uuid, text, text, text, text[], boolean, text, text) to authenticated;
grant execute on function public.asset_field_update(uuid, text, text, text[], boolean, text, text, integer) to authenticated;
grant execute on function public.asset_field_retire(uuid, boolean) to authenticated;
grant execute on function public.asset_field_set(uuid, jsonb) to authenticated;
