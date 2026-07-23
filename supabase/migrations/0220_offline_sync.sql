-- 0220_offline_sync.sql
-- Offline-first capture + sync layer (FleetWise F2 / FR-1.3, FR-15.1–15.4, FR-9.3).
--
-- The client queues mutations (log reading, report fault, add job-card line,
-- complete job card) in IndexedDB while offline, each stamped with a client-generated
-- idempotency UUID + client timestamp. On reconnect they flush to /api/sync, which
-- applies them idempotently (dedupe by client UUID) and records every mutation here.
--
-- `sync_log` doubles as the conflict record: status='conflict' rows keep the value that
-- lost last-writer-wins in `superseded` (never silently dropped). Reading conflicts are
-- resolved deterministically by `public.sync_apply_reading` (below): both reading rows
-- always persist in `meter_readings` (append-only history + audit_log), and the machine's
-- current reading always reflects the writer with the greatest client timestamp.

-- ── Track the client timestamp that "owns" a machine's current reading (LWW) ──
-- Additive, nullable. The online capture paths leave it null; the sync path sets it so
-- that a late-arriving older offline edit cannot roll the current reading backwards.
alter table machines add column if not exists current_reading_client_ts timestamptz;

-- ── Sync log / conflict table ─────────────────────────────────────
create table sync_log (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null,
  client_id   uuid not null,                 -- client idempotency key (per captured mutation)
  mutation    text not null,                 -- log_reading | report_fault | add_job_line | complete_job
  scope       text not null default 'app',   -- app | public (QR)
  entity      text,                          -- affected table
  entity_id   uuid,                          -- created/affected row id
  status      text not null,                 -- pending | applied | duplicate | conflict
  client_ts   timestamptz not null,          -- client-supplied capture time
  applied_at  timestamptz not null default now(),
  by_user     uuid references users(id),     -- null for anonymous QR captures
  payload     jsonb,                          -- the mutation's fields (recovery / audit)
  superseded  jsonb,                          -- LWW loser preserved here (no silent loss)
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  constraint sync_log_client_uq unique (client_id),
  constraint sync_log_farm_fk   foreign key (farm_id) references farms(id)
);
create index sync_log_farm_idx   on sync_log(farm_id);
create index sync_log_client_idx on sync_log(client_id);
create index sync_log_status_idx on sync_log(farm_id, status);

-- ── RLS: farm-scoped read; only the service role (the /api/sync route) writes it ──
-- Modelled on audit_log: clients may read their farm's rows but never write them.
alter table sync_log enable row level security;
alter table sync_log force  row level security;
create policy sync_log_sel on sync_log for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);

grant select on sync_log to authenticated;
-- 0102 set default privileges granting authenticated ins/upd/del on new tables — undo it here.
revoke insert, update, delete on sync_log from authenticated;
grant all on sync_log to service_role;

-- ── Audit every write (global convention) ─────────────────────────
create trigger sync_log_audit
  after insert or update or delete on public.sync_log
  for each row execute function app_audit();

-- ── Deterministic last-writer-wins reading apply (FR-15.3) ────────
-- Called (once, atomically) by the service-role /api/sync route. SECURITY DEFINER so it
-- can write across RLS; service-role only. Returns the applied status + the superseded
-- value (if any) so the route can persist a conflict record.
--
-- Guarantees:
--   * the reading is ALWAYS inserted into meter_readings (append-only history + audit);
--   * machines.current_reading ends at the reading with the greatest client_ts seen —
--     regardless of the order mutations arrive (deterministic);
--   * when a stale (older-timestamp) edit arrives after a newer one it LOSES: the machine
--     is left on the newer value and the loser is returned in `superseded`.
create or replace function public.sync_apply_reading(
  p_farm         uuid,
  p_machine      uuid,
  p_reading      numeric,
  p_reading_date date,
  p_source       meter_source,
  p_by_user      uuid,
  p_client_ts    timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev_reading numeric;
  v_prev_date    date;
  v_prev_ts      timestamptz;
  v_reading_id   uuid;
  v_is_winner    boolean;
  v_superseded   jsonb := null;
  v_status       text;
begin
  -- Lock the machine row and snapshot the current winner before inserting.
  select current_reading, current_reading_date, current_reading_client_ts
    into v_prev_reading, v_prev_date, v_prev_ts
    from machines where id = p_machine and farm_id = p_farm for update;
  if not found then
    raise exception 'sync_apply_reading: machine % not in farm %', p_machine, p_farm;
  end if;

  -- Append-only history row. Its AFTER trigger may advance current_reading by DATE;
  -- we re-assert the client-timestamp winner immediately below so LWW is authoritative.
  insert into meter_readings (farm_id, machine_id, reading, reading_date, source, by_user)
    values (p_farm, p_machine, p_reading, p_reading_date, p_source, p_by_user)
    returning id into v_reading_id;

  v_is_winner := (v_prev_ts is null) or (p_client_ts >= v_prev_ts);

  if v_is_winner then
    -- New winner. If it displaces a different prior value, preserve that value.
    if v_prev_ts is not null and v_prev_reading is distinct from p_reading then
      v_superseded := jsonb_build_object(
        'reading', v_prev_reading, 'reading_date', v_prev_date, 'client_ts', v_prev_ts);
    end if;
    update machines
      set current_reading = p_reading,
          current_reading_date = p_reading_date,
          current_reading_client_ts = p_client_ts
      where id = p_machine;
    v_status := 'applied';
  else
    -- Stale edit arriving late: it loses. Restore the winner (undo any date-based
    -- advance the insert trigger made) and preserve the losing value.
    update machines
      set current_reading = v_prev_reading,
          current_reading_date = v_prev_date,
          current_reading_client_ts = v_prev_ts
      where id = p_machine;
    v_superseded := jsonb_build_object(
      'reading', p_reading, 'reading_date', p_reading_date, 'client_ts', p_client_ts);
    v_status := 'conflict';
  end if;

  -- Recompute service-due from the final current reading.
  perform app.recalc_machine_service(p_machine);

  return jsonb_build_object(
    'status', v_status, 'reading_id', v_reading_id, 'superseded', v_superseded);
end $$;

revoke execute on function
  public.sync_apply_reading(uuid, uuid, numeric, date, meter_source, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.sync_apply_reading(uuid, uuid, numeric, date, meter_source, uuid, timestamptz)
  to service_role;
