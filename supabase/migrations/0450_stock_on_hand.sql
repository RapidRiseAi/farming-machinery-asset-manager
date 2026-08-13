-- 0450_stock_on_hand.sql
-- What is actually on the shelf (§6 inventory).
--
-- `parts_catalogue` (0270) has always been a LIST: part numbers, suppliers, a typical
-- cost. It answers "what does a fuel filter for the New Holland cost?" and cannot answer
-- "have we got one?" — so the question that actually stops a service at 6am on a Saturday
-- was the one the product could not take. Service kits (0271) made it sharper: a farm can
-- say a 250-hour service needs six parts, and still not know whether any of them are in
-- the store.
--
-- ── The shape, and why it is not new ────────────────────────────────────────
--
-- This is deliberately the F4 fuel model with different nouns. Fuel got that shape after
-- the double-count problem was thought through once (0241): a DELIVERY is stock arriving
-- and books nothing; an ISSUE to a machine is what attributes cost. Parts are the same
-- physical story — something arrives, sits on a shelf, and is later fitted to a machine —
-- so they get the same spine rather than a second, differently-shaped one.
--
--   stock_items      one row per (farm, catalogue part): where it lives, what is on hand
--   stock_movements  the ledger: receipt / issue / adjustment / return
--
-- `on_hand` is MAINTAINED BY TRIGGER from the ledger and is never typed. That is the
-- house pattern (job-card totals, partner payment rollups) and it exists because a typed
-- quantity drifts: two people issue the same filter at the same moment, both read 4, both
-- write 3, and the shelf is wrong for a month. A ledger plus a rollup cannot race that
-- way, and it can also answer "where did the other three go?", which a bare integer never
-- can.
--
-- ── The money rule (founder's decision) ─────────────────────────────────────
--
-- Parts differ from fuel in one way that matters: `job_card_lines` ALREADY book parts cost
-- through the 0211 trigger. So a rand issued from the store has two candidate owners, and
-- the rule this codebase is built on is that cost enters `cost_entries` exactly once.
--
-- The decision taken, and asserted both ways in rls_isolation.sql G13:
--
--   * a RECEIPT books nothing. Buying stock moves money from the bank to the shelf; it is
--     not yet a cost of owning any machine, and booking it here would charge a farm for a
--     filter still in its box.
--   * an ISSUE THAT NAMES A JOB CARD books nothing. The job card's own line already owns
--     that rand — this is the no-double-count rule the whole ledger depends on.
--   * an ISSUE WITH NO JOB CARD books a `parts` cost entry against the machine. This is
--     the "grabbed a filter off the shelf and fitted it" case, which is most of what
--     actually happens on a farm, and without it the stock drops while the money vanishes
--     and the machine's TCO quietly understates.
--   * an ADJUSTMENT or a RETURN never books anything — a stocktake correction is not a
--     cost, it is an admission that the count was wrong.

-- ── Kinds ────────────────────────────────────────────────────────────────────
create type stock_move_kind as enum ('receipt', 'issue', 'adjustment', 'return');

-- ── What is on the shelf ─────────────────────────────────────────────────────
create table stock_items (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,
  -- By id only, exactly as service_kit_items does: the part may be a GLOBAL catalogue row
  -- whose farm_id is null, so a composite FK cannot express it. The app only ever offers
  -- parts the user can already read, and catalogue RLS is what makes that true.
  part_catalogue_id uuid not null references parts_catalogue(id),
  unit              text not null default 'each',   -- each / litres / metres …
  -- Maintained by app_stock_rollup(). Numeric because oil and cable are not counted in
  -- whole numbers. May go NEGATIVE: a farm that issues what it forgot to receive should
  -- see -2 and fix it, not be blocked at the moment it is trying to record reality.
  on_hand           numeric(14,3) not null default 0,
  reorder_point     numeric(14,3),
  bin               text,                            -- "Shed 2, rack C"
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint stock_items_farm_fk foreign key (farm_id) references farms(id),
  constraint stock_items_id_farm_uq unique (id, farm_id)
);
-- One live stock record per part per farm. `nulls not distinct` is not needed: both
-- columns are not-null, and the partial index lets a deleted record be superseded.
create unique index stock_items_part_uq on stock_items (farm_id, part_catalogue_id)
  where deleted_at is null;
create index stock_items_farm_idx on stock_items (farm_id);

-- ── The ledger ───────────────────────────────────────────────────────────────
create table stock_movements (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null,
  stock_item_id   uuid not null,
  kind            stock_move_kind not null,
  -- Always POSITIVE. The direction is the kind's job, not the sign's — a negative receipt
  -- and a positive issue would both be readable as "minus three" by different people.
  qty             numeric(14,3) not null check (qty > 0),
  unit_cost_cents bigint,                          -- ex-VAT, integer cents (Scope §6)
  machine_id      uuid,
  job_card_id     uuid,
  occurred_on     date not null default current_date,
  note            text,
  by_user         uuid references users(id),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  constraint stock_movements_farm_fk    foreign key (farm_id) references farms(id),
  constraint stock_movements_item_fk    foreign key (stock_item_id, farm_id)
    references stock_items(id, farm_id) on delete cascade,
  -- Composite, so a movement can only ever point at a machine or a job card of its OWN
  -- farm — the tenancy rule the rest of this schema is built on.
  constraint stock_movements_machine_fk foreign key (machine_id, farm_id)
    references machines(id, farm_id),
  constraint stock_movements_job_fk     foreign key (job_card_id, farm_id)
    references job_cards(id, farm_id),
  -- A job card is always work on a machine, so a movement that names one without the
  -- other is a half-recorded issue.
  constraint stock_movements_job_needs_machine_ck check (job_card_id is null or machine_id is not null)
);
create index stock_movements_item_idx    on stock_movements (stock_item_id, occurred_on desc);
create index stock_movements_farm_idx    on stock_movements (farm_id);
create index stock_movements_machine_idx on stock_movements (machine_id) where machine_id is not null;

-- ── on_hand follows the ledger ───────────────────────────────────────────────
create or replace function app_stock_rollup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item uuid;
begin
  v_item := coalesce(new.stock_item_id, old.stock_item_id);

  update stock_items s
     set on_hand = coalesce((
           select sum(case m.kind
                        when 'receipt'    then  m.qty
                        when 'return'     then  m.qty     -- came back off the machine
                        when 'issue'      then -m.qty
                        when 'adjustment' then  m.qty     -- signed by the app: a stocktake
                      end)                                 -- writes the DIFFERENCE it found
           from stock_movements m
          where m.stock_item_id = v_item and m.deleted_at is null
         ), 0),
         updated_at = now()
   where s.id = v_item;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger stock_movements_rollup
after insert or update or delete on stock_movements
for each row execute function app_stock_rollup();

-- ── The money rule ───────────────────────────────────────────────────────────
create or replace function app_cost_from_stock_movement() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     stock_movements;
  v_amount  bigint;
  v_books   boolean;
  v_deleted boolean;
begin
  if tg_op = 'DELETE' then
    v_row := old; v_deleted := true;
  else
    v_row := new; v_deleted := (new.deleted_at is not null);
  end if;

  v_amount := round(coalesce(v_row.unit_cost_cents, 0) * v_row.qty);

  -- The whole decision, in one expression. Only an issue, only to a machine, only when no
  -- job card already owns the rand, and only when somebody said what it cost.
  v_books := v_row.kind = 'issue'
         and v_row.machine_id is not null
         and v_row.job_card_id is null
         and v_amount > 0;

  if v_deleted or not v_books then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'stock_movement' and source_id = v_row.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'stock_movement' and source_id = v_row.id) then
    update cost_entries
       set farm_id = v_row.farm_id, machine_id = v_row.machine_id, type = 'parts',
           amount_cents = v_amount, occurred_on = v_row.occurred_on,
           deleted_at = null, deleted_by = null
     where source_type = 'stock_movement' and source_id = v_row.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
    values (v_row.farm_id, v_row.machine_id, 'parts', v_amount, 'stock_movement', v_row.id, v_row.occurred_on);
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger stock_movements_cost
after insert or update or delete on stock_movements
for each row execute function app_cost_from_stock_movement();

-- ── RLS + grants + audit ─────────────────────────────────────────────────────
-- Farm-scoped like everything else, AND farm-side only. A contractor reaches a farm
-- through workshop_links, which `app.has_farm_access` deliberately admits — but what a
-- farm keeps on its shelves is not part of fixing a tractor, and F16 established that a
-- partner sees the narrowest slice that lets them work. There is no grant that opens this.
do $do$
declare t text;
begin
  foreach t in array array['stock_items','stock_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (app.has_farm_access(farm_id) and app.is_farm_side() and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.has_farm_access(farm_id) and app.is_farm_side())', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.has_farm_access(farm_id) and app.is_farm_side()) with check (app.has_farm_access(farm_id) and app.is_farm_side())', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.has_farm_access(farm_id) and app.is_farm_side())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app_audit()', t || '_audit', t);
  end loop;
end $do$;

comment on table stock_items is
  'What a farm has on the shelf for a catalogue part. on_hand is maintained by '
  'app_stock_rollup() from stock_movements and must never be written directly.';
comment on table stock_movements is
  'Append-only-by-convention ledger of stock in and out. A receipt books no cost; an '
  'issue naming a job card books no cost (the job-card line owns it); an issue to a '
  'machine with no job card books a parts cost entry. See 0450 header.';
