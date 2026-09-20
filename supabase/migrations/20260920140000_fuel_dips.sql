-- 20260920140000_fuel_dips.sql
-- What the tank actually holds, against what the books say it should.
--
-- `SCOPE.md` §9 asks for a "tank reconciliation view (deliveries − issues vs dip reading)".
-- The first half was built: /fuel shows a book balance. The dip — somebody putting a stick
-- in the tank — had nowhere to go, so the one number that catches a leak, a theft or a draw
-- nobody wrote down could not be recorded.
--
-- WHY THE VARIANCE IS THE POINT
-- ─────────────────────────────────────────────────────────────────────────────
-- A book balance is only ever as good as the captures behind it. Diesel that leaves without
-- a draw being logged shows up NOWHERE in this product until the tank is measured: the books
-- and the tank simply drift apart, and the SARS trail quietly stops matching the farm. The
-- dip is the outside check on our own data, which is exactly what a rebate claim is audited
-- against.
--
-- Deliberately NOT an adjustment. Recording a dip does not create a correcting draw or move
-- anything in the ledger: a variance is a question for a person ("who took 200 litres on
-- Tuesday?"), not an entry to be balanced away. Anything else would let a bookkeeping
-- convenience erase the evidence of a theft.

create table if not exists public.fuel_dips (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null,
  tank_id     uuid not null,
  dipped_on   date not null default current_date,
  litres      numeric(12,1) not null,
  note        text,
  by_user     uuid references public.users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  constraint fuel_dips_litres_ck check (litres >= 0 and litres <= 99999999999.9),
  constraint fuel_dips_tank_fk foreign key (tank_id, farm_id)
    references public.fuel_tanks(id, farm_id),
  constraint fuel_dips_farm_fk foreign key (farm_id) references public.farms(id),
  constraint fuel_dips_id_farm_uq unique (id, farm_id)
);
create index if not exists fuel_dips_tank_idx on public.fuel_dips(tank_id, dipped_on desc);
create index if not exists fuel_dips_farm_idx on public.fuel_dips(farm_id);

alter table public.fuel_dips enable row level security;
alter table public.fuel_dips force  row level security;

drop policy if exists fuel_dips_sel on public.fuel_dips;
create policy fuel_dips_sel on public.fuel_dips for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);

-- Whoever may draw diesel may measure the tank: it is the same person at the same bowser,
-- and a measurement nobody is allowed to record is a measurement nobody takes.
drop policy if exists fuel_dips_ins on public.fuel_dips;
create policy fuel_dips_ins on public.fuel_dips for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id)
      in ('rr_admin','owner','manager','mechanic','operator')
  );

-- Changing or removing a measurement after the fact is an office decision: the variance is
-- evidence, and evidence that any hand can rewrite is not evidence.
drop policy if exists fuel_dips_upd on public.fuel_dips;
create policy fuel_dips_upd on public.fuel_dips for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );
drop policy if exists fuel_dips_del on public.fuel_dips;
create policy fuel_dips_del on public.fuel_dips for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role((select auth.uid()), farm_id) in ('rr_admin','owner','manager')
  );

grant select, insert, update, delete on public.fuel_dips to authenticated;
grant all on public.fuel_dips to service_role;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'fuel_dips_audit') then
    create trigger fuel_dips_audit
      after insert or update or delete on public.fuel_dips
      for each row execute function app_audit();
  end if;
end $$;

-- ── The reconciliation, computed where both sides live ──────────────────────
-- Book litres are deliveries minus draws up to and including the dip's own date, so the
-- comparison is against what the books said AT THE MOMENT the stick went in. Comparing a
-- dip taken on the 3rd against today's book balance would report a variance for every draw
-- made since, which is how a reconciliation stops being believed.
create or replace function app.fuel_tank_reconciliation(p_tank uuid)
returns table (
  dipped_on date,
  dip_litres numeric,
  book_litres numeric,
  variance_litres numeric
)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select d.dipped_on,
         d.litres,
         coalesce(
           (select sum(fd.litres) from public.fuel_deliveries fd
             where fd.tank_id = d.tank_id and fd.deleted_at is null and fd.date <= d.dipped_on), 0)
         - coalesce(
           (select sum(fi.litres) from public.fuel_issues fi
             where fi.tank_id = d.tank_id and fi.deleted_at is null and fi.date <= d.dipped_on), 0)
           as book_litres,
         d.litres - (
           coalesce(
             (select sum(fd.litres) from public.fuel_deliveries fd
               where fd.tank_id = d.tank_id and fd.deleted_at is null and fd.date <= d.dipped_on), 0)
           - coalesce(
             (select sum(fi.litres) from public.fuel_issues fi
               where fi.tank_id = d.tank_id and fi.deleted_at is null and fi.date <= d.dipped_on), 0)
         ) as variance_litres
    from public.fuel_dips d
   where d.tank_id = p_tank
     and d.deleted_at is null
   order by d.dipped_on desc, d.created_at desc;
$$;

revoke execute on function app.fuel_tank_reconciliation(uuid) from public, anon;
grant execute on function app.fuel_tank_reconciliation(uuid) to authenticated, service_role;

comment on function app.fuel_tank_reconciliation(uuid) is
  'Each dip against the book balance on its own date. A negative variance is diesel the '
  'books say should be there and is not. It corrects nothing: a variance is a question.';

-- ── The public wrapper ──────────────────────────────────────────────────────
-- PostgREST exposes `public` ONLY: a function in schema `app` is unreachable from
-- `supabase.rpc()` and resolves to nothing at all. The screen calls this one.
create or replace function public.fuel_tank_reconciliation(p_tank uuid)
returns table (
  dipped_on date,
  dip_litres numeric,
  book_litres numeric,
  variance_litres numeric
)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select * from app.fuel_tank_reconciliation(p_tank);
$$;

revoke execute on function public.fuel_tank_reconciliation(uuid) from public, anon;
grant execute on function public.fuel_tank_reconciliation(uuid) to authenticated, service_role;
