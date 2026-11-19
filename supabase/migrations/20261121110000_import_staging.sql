-- 20261121110000_import_staging.sql
-- Task B5: structured import staging (BRIEF section 17, "Document extraction and structured import").
--
-- One staging flow for meter readings, whatever the source: a sheet today, a document read by an
-- OCR adapter once one is approved (the readiness flag document_extraction, off; the provider and
-- its cost on Professional are an open founder decision). Every candidate row keeps where it came
-- from (row, page, the source text) and how sure the reader was of each value. Nothing is written
-- until an owner or manager decides every row and confirms the batch; a row with an uncertain,
-- conflicting or unmatched value is written only with the values a person confirmed. Extracted
-- text is data: it is stored and compared, never executed or followed.
--
-- Additive: two tables, functions and a flag.

insert into public.feature_flags (key, note, released) values
  ('document_extraction', 'Reading readings from photos and PDFs into the import review. Off until a provider and its cost are approved.', false)
on conflict (key) do nothing;

create table if not exists public.import_batches (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null references public.farms(id),
  purpose       text not null default 'readings' check (purpose in ('readings')),
  source        text not null check (source in ('sheet', 'document')),
  file_name     text check (file_name is null or char_length(file_name) <= 200),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  provider      text check (provider is null or provider ~ '^[a-z0-9_-]{1,40}$'),
  pages         integer check (pages is null or pages between 1 and 500),
  status        text not null default 'review' check (status in ('review', 'confirmed', 'cancelled')),
  created_by    uuid references public.users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references public.users(id),
  decided_at    timestamptz,
  written       integer not null default 0,
  skipped       integer not null default 0,
  constraint import_batches_id_farm_uq unique (id, farm_id)
);
-- One live batch per source file: sending the same file again opens the batch already there.
create unique index if not exists import_batches_same_file on public.import_batches (farm_id, source_sha256)
  where source_sha256 is not null and status in ('review', 'confirmed');

create table if not exists public.import_rows (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null,
  farm_id          uuid not null,
  row_no           integer not null check (row_no between 1 and 10000),
  page             integer check (page is null or page between 1 and 500),
  raw              jsonb not null,
  machine_id       uuid,
  reading_date     date,
  reading          numeric(12,1),
  issues           text[] not null default '{}',
  decision         text not null default 'pending' check (decision in ('pending', 'accept', 'skip')),
  confirmed_by     uuid references public.users(id),
  confirmed_values boolean not null default false,
  written_reading  uuid,
  unique (batch_id, row_no),
  foreign key (batch_id, farm_id) references public.import_batches(id, farm_id),
  foreign key (machine_id, farm_id) references public.machines(id, farm_id)
);
create index if not exists import_rows_batch on public.import_rows (batch_id);

do $$ declare t text; begin
  foreach t in array array['import_batches', 'import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.app_audit()', t || '_audit', t);
  end loop;
end $$;

-- Owners and managers (and Rapid Rise in support) work imports.
create or replace function app.import_manager(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
     and coalesce(app.effective_farm_role((select auth.uid()), p_farm)::text, '') in ('rr_admin', 'owner', 'manager');
$$;
revoke all on function app.import_manager(uuid) from public, anon;
grant execute on function app.import_manager(uuid) to authenticated;

drop policy if exists import_batches_sel on public.import_batches;
create policy import_batches_sel on public.import_batches for select to authenticated using (app.import_manager(farm_id));
drop policy if exists import_rows_sel on public.import_rows;
create policy import_rows_sel on public.import_rows for select to authenticated using (app.import_manager(farm_id));
select app.pay_gate_apply('import_batches');
select app.pay_gate_apply('import_rows');

-- == Opening a batch ============================================================================
-- A document batch needs Professional or Complete AND the readiness flag; a sheet works on every
-- plan. The same file again answers with the batch already open or confirmed.
create or replace function public.import_batch_open(
  p_farm uuid, p_source text, p_file_name text default null, p_sha256 text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing public.import_batches;
  v_id uuid;
begin
  if not app.import_manager(p_farm) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(p_farm, true);
  if p_source not in ('sheet', 'document') or (p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'import-invalid' using errcode = '22023';
  end if;
  if p_source = 'document' then
    if not app.farm_plan_allows(p_farm, 'tco') then
      raise exception 'plan-feature-document_extraction' using errcode = '42501';
    end if;
    if not exists (select 1 from public.feature_flags f where f.key = 'document_extraction'
                    and (f.released or exists (select 1 from public.farm_feature_access a
                                                where a.farm_id = p_farm and a.key = f.key))) then
      raise exception 'import-extraction-off' using errcode = '42501';
    end if;
  end if;
  if p_sha256 is not null then
    perform pg_advisory_xact_lock(hashtextextended('import-file:' || p_farm::text || p_sha256, 0));
    select * into v_existing from public.import_batches
     where farm_id = p_farm and source_sha256 = p_sha256 and status in ('review', 'confirmed');
    if found then return jsonb_build_object('id', v_existing.id, 'reused', true, 'status', v_existing.status); end if;
  end if;
  insert into public.import_batches (farm_id, source, file_name, source_sha256, created_by)
  values (p_farm, p_source, left(nullif(btrim(coalesce(p_file_name, '')), ''), 200), p_sha256, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'reused', false, 'status', 'review');
end $$;

-- == Staging rows ===============================================================================
-- Rows as read: [{row_no, page?, asset, date, date_candidates?, reading, unit?, confidence?: {asset,
-- date, reading, unit}, source_text?}]. The asset is matched by name, serial or registration on
-- this business only; each problem is named, nothing is guessed. Called with the person's session
-- (a sheet) or by the service (an extraction job, after the flag and plan were checked at open).
create or replace function public.import_rows_stage(p_batch uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.import_batches;
  r jsonb;
  v_issues text[];
  v_machines uuid[];
  v_machine uuid;
  v_meter text;
  v_current numeric;
  v_current_date date;
  v_date date;
  v_reading numeric;
  v_text text;
  v_unit text;
  v_conf jsonb;
  v_n integer := 0;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  if auth.role() is distinct from 'service_role' and not app.import_manager(b.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(b.farm_id, true);
  if b.status <> 'review' then raise exception 'import-closed' using errcode = '22023'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'import-invalid' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_issues := '{}'; v_machine := null; v_date := null; v_reading := null;
    v_conf := coalesce(r -> 'confidence', '{}'::jsonb);
    -- The asset: one exact match on this business, or a named problem.
    v_text := lower(btrim(coalesce(r ->> 'asset', '')));
    select array_agg(m.id) into v_machines from public.machines m
     where m.farm_id = b.farm_id and m.deleted_at is null and v_text <> ''
       and (lower(btrim(m.name)) = v_text
            or upper(regexp_replace(coalesce(m.serial_no, ''), '[\s-]', '', 'g')) = upper(regexp_replace(v_text, '[\s-]', '', 'g'))
            or upper(regexp_replace(coalesce(m.reg_no, ''), '[\s-]', '', 'g')) = upper(regexp_replace(v_text, '[\s-]', '', 'g')));
    if coalesce(cardinality(v_machines), 0) = 0 then v_issues := v_issues || 'asset_unknown'::text;
    elsif cardinality(v_machines) > 1 then v_issues := v_issues || 'asset_ambiguous'::text;
    else v_machine := v_machines[1];
    end if;
    -- The date: ISO or day-first; never month-first; never in the future; a conflict is named.
    v_text := btrim(coalesce(r ->> 'date', ''));
    -- make_date refuses an impossible day (30/02) instead of rolling it into the next month.
    begin
      if v_text ~ '^\d{4}-\d{1,2}-\d{1,2}$' then
        v_date := make_date(split_part(v_text, '-', 1)::int, split_part(v_text, '-', 2)::int, split_part(v_text, '-', 3)::int);
      elsif v_text ~ '^\d{1,2}/\d{1,2}/\d{4}$' then
        v_date := make_date(split_part(v_text, '/', 3)::int, split_part(v_text, '/', 2)::int, split_part(v_text, '/', 1)::int);
      end if;
    exception when others then v_date := null;
    end;
    if v_date is null then v_issues := v_issues || 'date_invalid'::text;
    elsif v_date > v_today then v_issues := v_issues || 'date_future'::text; v_date := null;
    end if;
    if jsonb_typeof(r -> 'date_candidates') = 'array'
       and (select count(distinct value) from jsonb_array_elements_text(r -> 'date_candidates')) > 1 then
      v_issues := v_issues || 'date_conflict'::text;
    end if;
    -- The reading: a non-negative number with at most one decimal.
    begin
      v_reading := replace(regexp_replace(coalesce(r ->> 'reading', ''), '\s', '', 'g'), ',', '.')::numeric;
      if v_reading < 0 or v_reading > 99999999999.9 or v_reading <> round(v_reading, 1) then v_reading := null; end if;
    exception when others then v_reading := null;
    end;
    if v_reading is null then v_issues := v_issues || 'reading_invalid'::text; end if;
    -- Against the asset: the unit must be its meter's, and a reading never goes backwards.
    if v_machine is not null then
      select m.meter_type::text, m.current_reading, m.current_reading_date into v_meter, v_current, v_current_date
        from public.machines m where m.id = v_machine;
      v_unit := lower(btrim(coalesce(r ->> 'unit', '')));
      if v_unit <> '' and not ((v_unit in ('h', 'hr', 'hrs', 'hour', 'hours', 'uur') and v_meter = 'hours')
                               or (v_unit in ('km', 'kms', 'kilometre', 'kilometres', 'kilometer') and v_meter = 'km')) then
        v_issues := v_issues || 'unit_mismatch'::text;
      end if;
      if v_reading is not null and v_current is not null and v_date is not null
         and v_reading < v_current and v_date >= coalesce(v_current_date, v_date) then
        v_issues := v_issues || 'reading_backwards'::text;
      end if;
      if v_reading is not null and v_date is not null and exists (
           select 1 from public.meter_readings mr where mr.machine_id = v_machine and mr.deleted_at is null
              and mr.reading_date = v_date and mr.reading = v_reading) then
        v_issues := v_issues || 'duplicate_existing'::text;
      end if;
      if v_reading is not null and v_date is not null and exists (
           select 1 from public.import_rows ir where ir.batch_id = b.id and ir.machine_id = v_machine
              and ir.reading_date = v_date and ir.reading = v_reading) then
        v_issues := v_issues || 'duplicate_in_batch'::text;
      end if;
    end if;
    -- How sure the reader was: below 0.8 the value is uncertain and needs a person.
    if coalesce((v_conf ->> 'asset')::numeric, 1) < 0.8 then v_issues := v_issues || 'uncertain_asset'::text; end if;
    if coalesce((v_conf ->> 'date')::numeric, 1) < 0.8 then v_issues := v_issues || 'uncertain_date'::text; end if;
    if coalesce((v_conf ->> 'reading')::numeric, 1) < 0.8 then v_issues := v_issues || 'uncertain_reading'::text; end if;
    insert into public.import_rows (batch_id, farm_id, row_no, page, raw, machine_id, reading_date, reading, issues)
    values (b.id, b.farm_id, (r ->> 'row_no')::integer, nullif(r ->> 'page', '')::integer, r, v_machine, v_date, v_reading, v_issues)
    on conflict (batch_id, row_no) do nothing;
    v_n := v_n + 1;
  end loop;
  update public.import_batches set pages = greatest(coalesce(pages, 0), (select max(page) from public.import_rows where batch_id = b.id))
   where id = b.id and exists (select 1 from public.import_rows where batch_id = b.id and page is not null);
  return v_n;
end $$;

-- == A person decides each row ===================================================================
-- Accept as staged (only when nothing about the row is in doubt), accept with the values the person
-- typed or picked (machine, date, reading), or skip. A row with any issue is accepted only with
-- confirmed values: an uncertain value is never written because nobody objected.
create or replace function public.import_row_decide(
  p_row uuid, p_decision text, p_machine uuid default null, p_date date default null, p_reading numeric default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ir public.import_rows;
  b public.import_batches;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_confirmed boolean := p_machine is not null or p_date is not null or p_reading is not null;
begin
  select * into ir from public.import_rows where id = p_row for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into b from public.import_batches where id = ir.batch_id;
  if not app.import_manager(ir.farm_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(ir.farm_id, true);
  if b.status <> 'review' then raise exception 'import-closed' using errcode = '22023'; end if;
  if p_decision not in ('accept', 'skip', 'pending') then raise exception 'import-invalid' using errcode = '22023'; end if;
  if p_decision = 'accept' then
    if cardinality(ir.issues) > 0 and not v_confirmed then raise exception 'import-unreviewed' using errcode = '22023'; end if;
    if p_machine is not null and not exists (select 1 from public.machines m where m.id = p_machine and m.farm_id = ir.farm_id and m.deleted_at is null) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_date is not null and p_date > v_today then raise exception 'import-date-future' using errcode = '22023'; end if;
    if p_reading is not null and (p_reading < 0 or p_reading > 99999999999.9 or p_reading <> round(p_reading, 1)) then
      raise exception 'import-invalid' using errcode = '22023';
    end if;
    if coalesce(p_machine, ir.machine_id) is null or coalesce(p_date, ir.reading_date) is null or coalesce(p_reading, ir.reading) is null then
      raise exception 'import-incomplete' using errcode = '22023';
    end if;
  end if;
  update public.import_rows set
    decision = p_decision,
    machine_id = case when p_decision = 'accept' then coalesce(p_machine, machine_id) else machine_id end,
    reading_date = case when p_decision = 'accept' then coalesce(p_date, reading_date) else reading_date end,
    reading = case when p_decision = 'accept' then coalesce(p_reading, reading) else reading end,
    confirmed_values = (p_decision = 'accept' and v_confirmed),
    confirmed_by = case when p_decision = 'pending' then null else auth.uid() end
  where id = ir.id;
end $$;

-- == Confirming the batch =======================================================================
-- Every row decided; each accepted row checked again at write time (the asset still here, the date
-- not in the future, no identical reading added since staging); written once. A second confirm is
-- a no-op.
create or replace function public.import_batch_confirm(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.import_batches;
  ir public.import_rows;
  v_id uuid;
  v_written integer := 0;
  v_skipped integer := 0;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found or not app.import_manager(b.farm_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(b.farm_id, true);
  if b.status = 'confirmed' then return jsonb_build_object('written', b.written, 'skipped', b.skipped, 'reused', true); end if;
  if b.status <> 'review' then raise exception 'import-closed' using errcode = '22023'; end if;
  if exists (select 1 from public.import_rows where batch_id = b.id and decision = 'pending') then
    raise exception 'import-undecided' using errcode = '22023';
  end if;
  for ir in select * from public.import_rows where batch_id = b.id order by row_no for update loop
    if ir.decision <> 'accept' then v_skipped := v_skipped + 1; continue; end if;
    -- A row with an issue only ever reaches 'accept' with confirmed values (import_row_decide).
    if cardinality(ir.issues) > 0 and not ir.confirmed_values then raise exception 'import-unreviewed' using errcode = '22023'; end if;
    if ir.machine_id is null or ir.reading_date is null or ir.reading is null or ir.reading_date > v_today
       or not exists (select 1 from public.machines m where m.id = ir.machine_id and m.farm_id = b.farm_id and m.deleted_at is null)
       or exists (select 1 from public.meter_readings mr where mr.machine_id = ir.machine_id and mr.deleted_at is null
                    and mr.reading_date = ir.reading_date and mr.reading = ir.reading) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.meter_readings (farm_id, machine_id, reading, reading_date, source, by_user)
    values (b.farm_id, ir.machine_id, ir.reading, ir.reading_date, 'manual', auth.uid())
    returning id into v_id;
    update public.import_rows set written_reading = v_id where id = ir.id;
    v_written := v_written + 1;
  end loop;
  update public.import_batches set status = 'confirmed', decided_by = auth.uid(), decided_at = now(),
    written = v_written, skipped = v_skipped where id = b.id;
  return jsonb_build_object('written', v_written, 'skipped', v_skipped, 'reused', false);
end $$;

create or replace function public.import_batch_cancel(p_batch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.import_batches;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found or not app.import_manager(b.farm_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(b.farm_id, true);
  if b.status = 'review' then
    update public.import_batches set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = b.id;
  end if;
end $$;

revoke all on function public.import_batch_open(uuid, text, text, text) from public, anon;
revoke all on function public.import_rows_stage(uuid, jsonb) from public, anon;
revoke all on function public.import_row_decide(uuid, text, uuid, date, numeric) from public, anon;
revoke all on function public.import_batch_confirm(uuid) from public, anon;
revoke all on function public.import_batch_cancel(uuid) from public, anon;
grant execute on function public.import_batch_open(uuid, text, text, text) to authenticated;
grant execute on function public.import_rows_stage(uuid, jsonb) to authenticated, service_role;
grant execute on function public.import_row_decide(uuid, text, uuid, date, numeric) to authenticated;
grant execute on function public.import_batch_confirm(uuid) to authenticated;
grant execute on function public.import_batch_cancel(uuid) to authenticated;
