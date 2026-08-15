-- 0483_recurring_expenses.sql
-- The same bill, every month, without anybody remembering to capture it.
--
-- 0433 gave the SALES side standing invoices, for exactly the right reason: the failure
-- is not billing the wrong amount, it is forgetting. The cost side has had nothing, and
-- it has the same problem in a worse shape. Rent, insurance, the monthly parts account,
-- salaries, the accountant's retainer and the debit order for the alarm all repeat, and
-- every one of them is typed in by hand every month. A partner who misses three of them
-- is not short of a receipt — their profit reads high, their VAT return under-claims
-- input VAT, and their creditors list says they owe less than they do. Nothing on any
-- screen says so, because the row that would have said it was never captured.
--
-- ── The shape ────────────────────────────────────────────────────────────────
--
-- Deliberately the mirror of `recurring_invoices`: a schedule holds everything an expense
-- needs plus a cadence and the date of the next one, and the nightly cron walks the ones
-- that are due and writes ORDINARY `partner_expenses` rows. Not a parallel ledger, not a
-- flagged variety of expense — the same table, so a generated row lands in the VAT
-- return, `app.partner_pl`, the expense breakdown and the creditors ageing with no
-- special casing anywhere. Nothing downstream needs to learn that this feature exists.
--
-- ── Why there are no lines here, when the sales side has them ────────────────
--
-- A `recurring_invoice` carries lines because the document it raises carries lines: an
-- invoice is a list of things charged for, and the generator copies that list across. A
-- `partner_expense` is a single amount with a single VAT figure — 0430 made it that way
-- on purpose, because a supplier's invoice is a source document and what the books need
-- from it is the total and the VAT line, not a re-typing of its contents. A lines table
-- here would have exactly one row per schedule, forever, and its total would be a second
-- place the amount lives. So the amount sits on the header, and this table has no child.
--
-- ── Two decisions worth stating ──────────────────────────────────────────────
--
-- 1. It records the expense as STILL OWED by default. `auto_paid` is the mirror of the
--    sales side's `auto_send`: a stop order or debit order genuinely does leave the bank
--    on the day, and for those the schedule can stamp `paid_on` itself. It is off by
--    default because the two errors are not symmetric — an expense wrongly marked paid
--    disappears from the creditors list and from "who do I owe", and the partner finds
--    out when the supplier phones. An expense wrongly left unpaid is visible and one tap
--    from being corrected.
--
-- 2. It CANNOT run twice for the same period, on the same key and for the same reasons
--    as 0433: `last_period_start` records the period a run covered, and the generator
--    skips a schedule whose next period is not past it. A cron that fires twice, a retry
--    after a half-finished night, and the partner's own "capture it now" all pass through
--    that one guard, so October's rent is captured once however many times it is asked
--    for. Double-counting a cost is not a cosmetic bug here: it overstates cost on the
--    money screen and over-claims input VAT on a return that gets filed.
--
-- Scope: WORKSHOP, like `partner_expenses` and `partner_clients`. A farm has no business
-- reading what its contractor pays in rent, and the policy set says so directly rather
-- than reaching for a farm helper.

create table recurring_expenses (
  id                  uuid primary key default gen_random_uuid(),
  workshop_id         uuid not null references workshops(id) on delete cascade,

  -- What the partner calls this schedule ("Workshop rent", "Santam — bakkie"). Separate
  -- from the supplier because one supplier can be several standing charges.
  name                text not null,

  -- FREE TEXT, and it stays free text. A supplier here is a name on a recurring bill, and
  -- requiring it to be a record first would put a filing step in front of the thing that
  -- stops money being forgotten. Structured supplier records are arriving separately and
  -- resolve this name to an id themselves; this column is what they read.
  supplier_name       text not null,
  supplier_vat_number text,                       -- needed on a claim over R5 000 (VAT Act s20(4))
  reference           text,                       -- account or policy number on the standing bill
  description         text,
  category            partner_expense_category not null default 'other',

  -- Money, integer cents, EX-VAT — the same rule as everywhere else in this schema. The
  -- VAT amount is carried alongside rather than derived, exactly as `partner_expenses`
  -- carries it: a standing invoice has a printed VAT line and that is what may be
  -- claimed, so the schedule stores the figure it is going to copy rather than one it
  -- recomputes to a different cent each month.
  amount_cents        bigint  not null,
  vat_rate_bps        int     not null default 1500,
  vat_cents           bigint  not null default 0,
  -- VAT Act s17(2): entertainment, most passenger vehicles and club fees carry VAT that
  -- cannot be claimed back. A standing charge is exactly where this gets forgotten,
  -- because it is set up once and then never looked at again.
  vat_claimable       boolean not null default true,

  cadence             recurrence_cadence not null default 'monthly',
  -- The next expense's DATE — the date that goes on the row, which is the date the VAT
  -- return and the P&L period it. Moved forward by one cadence after each run.
  next_due_date       date not null,
  -- Stop after this date, or never (null). A two-year finance agreement should not have
  -- to be remembered either.
  ends_on             date,
  -- The start of the period the LAST run covered. The idempotency key: a run is skipped
  -- unless the period it is about to capture is later than this one.
  last_period_start   date,
  last_expense_id     uuid references partner_expenses(id),

  -- Off by default. See note 1 above.
  auto_paid           boolean not null default false,
  active              boolean not null default true,

  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid,

  -- The same money constraints `partner_expenses` enforces, enforced HERE too. A schedule
  -- that cannot produce a valid expense should be refused when it is set up, in front of
  -- the person who can fix it, rather than at 2am inside the cron where the failure is a
  -- log line nobody reads.
  constraint recurring_expenses_amount_ck check (amount_cents > 0),
  constraint recurring_expenses_vat_ck    check (vat_cents >= 0),
  constraint recurring_expenses_rate_ck   check (vat_rate_bps between 0 and 10000),
  constraint recurring_expenses_zero_ck   check (vat_rate_bps > 0 or vat_cents = 0),
  -- Only meaningful while the schedule is LIVE. When it reaches its end date the
  -- generator moves next_due_date past ends_on and switches active off in the same
  -- update — that is the correct terminal state, and an unconditional check would refuse
  -- the very write that stops the schedule.
  constraint recurring_expenses_ends_ck check (
    ends_on is null or not active or ends_on >= next_due_date
  )
);

create index recurring_expenses_due_idx on recurring_expenses(next_due_date)
  where active and deleted_at is null;
create index recurring_expenses_workshop_idx on recurring_expenses(workshop_id, active);

comment on table recurring_expenses is
  'A standing COST the nightly cron captures on a cadence (G19) — rent, insurance, '
  'salaries, a monthly account. Writes ordinary partner_expenses rows, so generated spend '
  'reaches the VAT return, the P&L and the creditors ageing with no special casing. '
  '`last_period_start` makes a run idempotent, so a double-fired cron cannot book '
  'October''s rent twice. `supplier_name` is free text by design.';

comment on column recurring_expenses.last_period_start is
  'The period the last run covered. The idempotency key: the cron, a retry and the '
  'partner''s own "capture it now" all check it, so one period yields one expense.';

-- ── RLS: the partner's own books, and nobody else's ──────────────────────────
-- Copied from `partner_expenses` (0430) rather than generalised, because these rows are
-- the same class of secret: what a contractor pays its landlord and its staff is not
-- something the farms it works for, or the contractor down the road, get to read.
-- Anon gets nothing — 0102 revokes the default privileges and no anon policy exists.
alter table recurring_expenses enable row level security;
alter table recurring_expenses force  row level security;

create policy recurring_expenses_sel on recurring_expenses for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy recurring_expenses_ins on recurring_expenses for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy recurring_expenses_upd on recurring_expenses for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy recurring_expenses_del on recurring_expenses for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

grant select, insert, update, delete on recurring_expenses to authenticated;
grant all on recurring_expenses to service_role;

create trigger recurring_expenses_audit after insert or update or delete on recurring_expenses
  for each row execute function app_audit();

-- ── The generator ────────────────────────────────────────────────────────────
-- SECURITY DEFINER because the nightly cron runs with no session, exactly like the other
-- 0205-pattern engines and like `app.generate_recurring_invoices`. It is never called
-- from the client: execute is revoked from public, anon and authenticated (a function
-- with no explicit grant defaults to EXECUTE TO PUBLIC, which is the hole 0440 exists to
-- remember), and the partner-facing "capture it now" goes through
-- `public.run_recurring_expense`, which checks ownership first.
create or replace function app.generate_recurring_expenses(p_only uuid default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r        record;
  v_period date;
  v_next   date;
  v_exp    uuid;
  v_made   int := 0;
begin
  for r in
    select re.*
      from recurring_expenses re
      join workshops w on w.id = re.workshop_id and w.deleted_at is null
     where re.deleted_at is null
       and re.active
       and (p_only is null or re.id = p_only)
       and re.next_due_date <= current_date
       and (re.ends_on is null or re.next_due_date <= re.ends_on)
     -- Locked as each row is fetched, and only the schedule row — the workshop join is a
     -- filter, not something to hold. This is one step beyond the sales-side mirror and it
     -- is deliberate: `last_period_start` makes a SEQUENCE of runs idempotent, but two
     -- runs overlapping (a cron that fires twice within a second, a retry launched while
     -- the first is still going) could both read the row before either writes the key
     -- back. The lock makes the second one wait and re-read, at which point the guard
     -- below sees the period already covered and skips it.
     for update of re
  loop
    v_period := r.next_due_date;
    v_next   := app.advance_by_cadence(v_period, r.cadence);

    -- Already done. A cron that fires twice, a retry after a half-finished night, or a
    -- partner pressing "capture it now" on a schedule that already ran cannot book the
    -- same month's rent a second time. The date still moves on, so a schedule left
    -- behind by an outage catches up one period per run rather than sticking.
    if r.last_period_start is not null and v_period <= r.last_period_start then
      update recurring_expenses
         set next_due_date = v_next, updated_at = now()
       where id = r.id;
      continue;
    end if;

    -- An ordinary expense in every respect. Same table, same columns, same audit trigger
    -- as one typed in by hand — the only thing that distinguishes it is that nobody had
    -- to remember. `expense_date` is the PERIOD date, not today's: a run that happens
    -- late still books the cost into the month it belongs to, which is what keeps a VAT
    -- return built on the invoice basis correct.
    insert into partner_expenses (
      workshop_id, supplier_name, supplier_vat_number, reference, category, description,
      expense_date, paid_on, amount_cents, vat_rate_bps, vat_cents, vat_claimable, created_by
    ) values (
      r.workshop_id, r.supplier_name, r.supplier_vat_number, r.reference, r.category,
      coalesce(r.description, r.name),
      v_period,
      -- A stop order really does leave the bank on the day. Anything else is still owed
      -- until the partner says otherwise — see note 1 in the header.
      case when r.auto_paid then v_period else null end,
      r.amount_cents, r.vat_rate_bps,
      -- Belt and braces against a schedule whose rate was later zeroed: a zero-rated
      -- purchase cannot carry VAT (partner_expenses_zero_ck), and failing the whole
      -- night's run on a constraint is a worse outcome than booking the cost with no VAT.
      case when r.vat_rate_bps > 0 then r.vat_cents else 0 end,
      r.vat_claimable, r.created_by
    ) returning id into v_exp;

    update recurring_expenses
       set last_period_start = v_period,
           last_expense_id   = v_exp,
           next_due_date     = v_next,
           -- A schedule that has reached its end date stops rather than sitting due for
           -- ever, and the ends-check above tolerates exactly this write.
           active            = case when r.ends_on is not null and v_next > r.ends_on
                                    then false else r.active end,
           updated_at        = now()
     where id = r.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_recurring_expenses(uuid) from public, anon, authenticated;
grant  execute on function app.generate_recurring_expenses(uuid) to service_role;

create or replace function public.cron_generate_recurring_expenses() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return app.generate_recurring_expenses(null);
end $$;
revoke execute on function public.cron_generate_recurring_expenses() from public, anon, authenticated;
grant  execute on function public.cron_generate_recurring_expenses() to service_role;

-- ── "Capture it now" ─────────────────────────────────────────────────────────
-- The partner's own button, for the schedule they have just set up and do not want to
-- wait a month to see work, and for the month the cron was not running. Ownership is
-- checked HERE rather than relying on the generator, because the generator is SECURITY
-- DEFINER and would otherwise honour any id passed to it — including another workshop's,
-- which would write a cost into somebody else's books.
create or replace function public.run_recurring_expense(p_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_workshop uuid;
begin
  select workshop_id into v_workshop from recurring_expenses
   where id = p_id and deleted_at is null;
  if v_workshop is null then raise exception 'schedule not found' using errcode = 'P0002'; end if;

  if not app.is_rr_admin() and v_workshop is distinct from app.user_workshop_id() then
    raise exception 'That schedule belongs to another business.' using errcode = '42501';
  end if;

  return app.generate_recurring_expenses(p_id);
end $$;

revoke execute on function public.run_recurring_expense(uuid) from public, anon;
grant  execute on function public.run_recurring_expense(uuid) to authenticated, service_role;

comment on function public.run_recurring_expense(uuid) is
  'Capture this schedule''s next expense now. Ownership is checked here because the '
  'generator it calls is SECURITY DEFINER and would otherwise trust any id. Runs the same '
  'code path as the cron, including the same "already done this period" guard, so '
  'pressing it twice cannot book the cost twice.';
