-- 0211_cost_entries_sync.sql
-- Keep `cost_entries` (0210) in sync with the rows that generate costs, plus the
-- canonical TCO rollup. All sync functions are SECURITY DEFINER (owned by a
-- BYPASSRLS role) so they can maintain the ledger regardless of the caller's RLS,
-- writing only farm-scoped rows derived from the source row's own farm_id.
--
-- Sources → cost_entries:
--   * job_card_lines  → parts | labour | other   (source_type='job_card_line')
--   * machines        → purchase                  (source_type='machine')
--   * machines        → finance (interest)        (source_type='machine_finance')
--   * fuel_deliveries → fuel (farm-level)         (source_type='fuel_delivery')
--   * job cards       → invoice                   (source_type='job_card', written by the app)
-- Each synced row is keyed by (source_type, source_id) so re-fires upsert rather than
-- duplicate. Soft-deleting the source soft-deletes its cost entry (history preserved).

-- ── Job-card lines → parts/labour/other ──────────────────────────
create or replace function app_cost_from_job_card_line() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_line      job_card_lines;
  v_deleted   boolean;
  v_machine   uuid;
  v_when      date;
  v_type      cost_entry_type;
begin
  if tg_op = 'DELETE' then
    v_line := old; v_deleted := true;
  else
    v_line := new; v_deleted := (new.deleted_at is not null);
  end if;

  select jc.machine_id, coalesce(jc.date_out, jc.date_in, jc.created_at::date)
    into v_machine, v_when
    from job_cards jc where jc.id = v_line.job_card_id;

  v_type := case v_line.kind
              when 'part'   then 'parts'::cost_entry_type
              when 'labour' then 'labour'::cost_entry_type
              else 'other'::cost_entry_type
            end;

  if v_deleted then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'job_card_line' and source_id = v_line.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'job_card_line' and source_id = v_line.id) then
    update cost_entries
       set farm_id = v_line.farm_id, machine_id = v_machine, type = v_type,
           amount_cents = coalesce(v_line.total_cents, 0), occurred_on = coalesce(v_when, current_date),
           deleted_at = null, deleted_by = null
     where source_type = 'job_card_line' and source_id = v_line.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
    values (v_line.farm_id, v_machine, v_type, coalesce(v_line.total_cents, 0),
            'job_card_line', v_line.id, coalesce(v_when, current_date));
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger job_card_lines_cost
  after insert or update or delete on job_card_lines
  for each row execute function app_cost_from_job_card_line();

-- ── Machines → purchase + finance-interest cost entries ──────────
create or replace function app_cost_from_machine() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_when     date := coalesce(new.purchase_date, new.created_at::date, current_date);
  v_interest bigint;
begin
  -- purchase (capital price)
  if new.deleted_at is null and coalesce(new.purchase_price_cents, 0) <> 0 then
    if exists (select 1 from cost_entries where source_type = 'machine' and source_id = new.id) then
      update cost_entries
         set farm_id = new.farm_id, machine_id = new.id, type = 'purchase',
             amount_cents = new.purchase_price_cents, occurred_on = v_when, deleted_at = null, deleted_by = null
       where source_type = 'machine' and source_id = new.id;
    else
      insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
      values (new.farm_id, new.id, 'purchase', new.purchase_price_cents, 'machine', new.id, v_when);
    end if;
  else
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'machine' and source_id = new.id and deleted_at is null;
  end if;

  -- finance interest = (monthly × term) − principal, when derivable and positive.
  -- (This is the *extra* cost of financing; the principal itself is the purchase entry,
  --  so the two never double-count.)
  v_interest := null;
  if new.finance_monthly_cents is not null and new.finance_term_months is not null and new.finance_total_cents is not null then
    v_interest := new.finance_monthly_cents * new.finance_term_months - new.finance_total_cents;
  end if;
  if new.deleted_at is null and coalesce(v_interest, 0) > 0 then
    if exists (select 1 from cost_entries where source_type = 'machine_finance' and source_id = new.id) then
      update cost_entries
         set farm_id = new.farm_id, machine_id = new.id, type = 'finance',
             amount_cents = v_interest, occurred_on = v_when, deleted_at = null, deleted_by = null
       where source_type = 'machine_finance' and source_id = new.id;
    else
      insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
      values (new.farm_id, new.id, 'finance', v_interest, 'machine_finance', new.id, v_when);
    end if;
  else
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'machine_finance' and source_id = new.id and deleted_at is null;
  end if;

  return new;
end $$;

create trigger machines_cost
  after insert or update on machines
  for each row execute function app_cost_from_machine();

-- ── Fuel deliveries → farm-level fuel cost (machine_id null) ──────
-- So a farm's TCO already reflects fuel spend before the fuel UI (F4) ships. Fuel
-- deliveries are tank-level (not attributable to one asset), hence machine_id = null.
create or replace function app_cost_from_fuel_delivery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     fuel_deliveries;
  v_amount  bigint;
  v_deleted boolean;
begin
  if tg_op = 'DELETE' then
    v_row := old; v_deleted := true;
  else
    v_row := new; v_deleted := (new.deleted_at is not null);
  end if;

  v_amount := (round(coalesce(v_row.litres, 0) * coalesce(v_row.price_per_l_cents, 0)))::bigint;

  if v_deleted or v_amount = 0 then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'fuel_delivery' and source_id = v_row.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'fuel_delivery' and source_id = v_row.id) then
    update cost_entries
       set farm_id = v_row.farm_id, machine_id = null, type = 'fuel',
           amount_cents = v_amount, occurred_on = coalesce(v_row.date, current_date), deleted_at = null, deleted_by = null
     where source_type = 'fuel_delivery' and source_id = v_row.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
    values (v_row.farm_id, null, 'fuel', v_amount, 'fuel_delivery', v_row.id, coalesce(v_row.date, current_date));
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger fuel_deliveries_cost
  after insert or update or delete on fuel_deliveries
  for each row execute function app_cost_from_fuel_delivery();

-- These sync functions are trigger-only; keep them out of the PostgREST RPC surface.
revoke execute on function
  app_cost_from_job_card_line(),
  app_cost_from_machine(),
  app_cost_from_fuel_delivery()
from anon, authenticated, public;

-- ── Canonical TCO rollup (Scope §23) ─────────────────────────────
-- SECURITY INVOKER so RLS applies — a caller only sums their own farm's ledger.
create or replace function app.machine_tco(p_machine uuid) returns bigint
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(amount_cents), 0)::bigint
  from public.cost_entries
  where machine_id = p_machine and deleted_at is null;
$$;
grant execute on function app.machine_tco(uuid) to authenticated, service_role;

-- ── Idempotent backfill for pre-existing rows (production) ────────
-- No-op on the test DB (tables are empty when migrations run; the seed then fires the
-- triggers above). Each block skips rows that already have a synced cost entry.
insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
select m.farm_id, m.id, 'purchase', m.purchase_price_cents, 'machine', m.id,
       coalesce(m.purchase_date, m.created_at::date, current_date)
from machines m
where m.deleted_at is null and coalesce(m.purchase_price_cents, 0) <> 0
  and not exists (select 1 from cost_entries ce where ce.source_type = 'machine' and ce.source_id = m.id);

insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
select m.farm_id, m.id, 'finance', (m.finance_monthly_cents * m.finance_term_months - m.finance_total_cents),
       'machine_finance', m.id, coalesce(m.purchase_date, m.created_at::date, current_date)
from machines m
where m.deleted_at is null
  and m.finance_monthly_cents is not null and m.finance_term_months is not null and m.finance_total_cents is not null
  and (m.finance_monthly_cents * m.finance_term_months - m.finance_total_cents) > 0
  and not exists (select 1 from cost_entries ce where ce.source_type = 'machine_finance' and ce.source_id = m.id);

insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
select l.farm_id, jc.machine_id,
       (case l.kind when 'part' then 'parts' when 'labour' then 'labour' else 'other' end)::cost_entry_type,
       coalesce(l.total_cents, 0), 'job_card_line', l.id,
       coalesce(jc.date_out, jc.date_in, jc.created_at::date)
from job_card_lines l join job_cards jc on jc.id = l.job_card_id
where l.deleted_at is null
  and not exists (select 1 from cost_entries ce where ce.source_type = 'job_card_line' and ce.source_id = l.id);

insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
select d.farm_id, null, 'fuel', (round(coalesce(d.litres, 0) * coalesce(d.price_per_l_cents, 0)))::bigint,
       'fuel_delivery', d.id, coalesce(d.date, current_date)
from fuel_deliveries d
where d.deleted_at is null
  and (round(coalesce(d.litres, 0) * coalesce(d.price_per_l_cents, 0)))::bigint > 0
  and not exists (select 1 from cost_entries ce where ce.source_type = 'fuel_delivery' and ce.source_id = d.id);
