-- 0430_partner_expenses.sql
-- The other half of the books.
--
-- Everything built so far is the SALES side: what the partner billed, what came in, what
-- is still owed. A business has two sides, and without the second one two things a
-- partner genuinely needs are impossible:
--
--   * a VAT return. Output VAT alone is not a return — SARS wants what you charged MINUS
--     what you were charged, and a partner who can only see the first half has to
--     assemble the second in a spreadsheet at filing time. That is the single thing most
--     likely to send them back to the tool they were using before.
--   * whether the month made money. Turnover is not profit. A workshop that billed
--     R180 000 and spent R160 000 on parts had a bad month, and nothing here could say so.
--
-- Scope: WORKSHOP, like `partner_clients` (F15). These are the partner's own purchases;
-- no farm has any business reading them, and the policy set says so directly rather than
-- reaching for a farm helper.

-- ── What kind of spend it is ─────────────────────────────────────────────────
-- Deliberately short, and in a workshop's own words. A long chart of accounts is how a
-- capture screen stops being used; these are the buckets a small trade business actually
-- sorts receipts into, and `other` carries the tail.
create type partner_expense_category as enum (
  'parts',          -- stock and spares bought in
  'subcontract',    -- work put out to somebody else
  'fuel',           -- diesel, petrol, the bakkie
  'vehicle',        -- service, tyres, licensing on their own vehicles
  'tools',          -- equipment and consumables
  'rent',           -- premises
  'salaries',       -- wages and labour
  'insurance',
  'admin',          -- phone, internet, software, stationery
  'marketing',
  'bank_fees',
  'other'
);

create table partner_expenses (
  id                  uuid primary key default gen_random_uuid(),
  workshop_id         uuid not null references workshops(id) on delete cascade,

  supplier_name       text not null,
  supplier_vat_number text,                       -- needed on a claim over R5 000 (VAT Act s20(4))
  reference           text,                       -- the supplier's own invoice number
  category            partner_expense_category not null default 'other',
  description         text,

  -- Time of supply: the date on the SUPPLIER's invoice, not when it was captured or paid.
  -- That is the date a VAT return is built from, so it is the one the form asks for.
  expense_date        date not null default current_date,
  paid_on             date,                       -- null = still owed to the supplier

  -- Money, integer cents, ex-VAT — the same rule as everywhere else in this schema.
  amount_cents        bigint not null,
  vat_rate_bps        int    not null default 1500,
  -- VAT is CAPTURED, not derived. A supplier invoice is the source document and its VAT
  -- line is what may be claimed; deriving it from a rate would disagree with the paper by
  -- a cent or two, and mixed-rate invoices exist. The form fills this in from the rate and
  -- lets it be corrected.
  vat_cents           bigint not null default 0,

  -- VAT Act s17(2): entertainment, most passenger vehicles and club fees carry VAT that
  -- cannot be claimed back. Recording the flag on the row is what keeps the return honest
  -- — the alternative is a partner remembering to leave those out by hand every quarter.
  vat_claimable       boolean not null default true,

  receipt_path        text,                       -- object in `partner-receipts`

  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid,

  constraint partner_expenses_amount_ck check (amount_cents > 0),
  constraint partner_expenses_vat_ck    check (vat_cents >= 0),
  constraint partner_expenses_rate_ck   check (vat_rate_bps between 0 and 10000),
  -- A zero-rated purchase cannot carry VAT, and VAT that is not claimable is not zero —
  -- it is simply not claimed. Both stay expressible; only the contradiction is refused.
  constraint partner_expenses_zero_ck   check (vat_rate_bps > 0 or vat_cents = 0)
);

create index partner_expenses_workshop_idx on partner_expenses(workshop_id, expense_date desc);
create index partner_expenses_unpaid_idx   on partner_expenses(workshop_id, paid_on)
  where paid_on is null and deleted_at is null;

comment on table partner_expenses is
  'What the partner BOUGHT (G6). Workshop-scoped: a farm never reads its contractor''s '
  'purchases. Feeds input VAT on the VAT return and the profit view; money is ex-VAT '
  'integer cents with the supplier''s own VAT amount captured alongside it.';

-- ── RLS: the partner's own books, and nobody else's ──────────────────────────
-- Same shape as `partner_clients` (0390): own workshop or rr_admin, no farm path at all.
-- Anon gets nothing — 0102 revokes the default privileges and no anon policy exists.
alter table partner_expenses enable row level security;
alter table partner_expenses force  row level security;

create policy partner_expenses_sel on partner_expenses for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy partner_expenses_ins on partner_expenses for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy partner_expenses_upd on partner_expenses for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy partner_expenses_del on partner_expenses for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

grant select, insert, update, delete on partner_expenses to authenticated;
grant all on partner_expenses to service_role;

create trigger partner_expenses_audit after insert or update or delete on partner_expenses
  for each row execute function app_audit();

-- ── Receipts ─────────────────────────────────────────────────────────────────
-- `attachments.farm_id` is NOT NULL, so an expense cannot live there — it belongs to a
-- workshop, not a farm. It gets its own workshop-scoped bucket instead, on the same
-- pattern as the letterhead (0382): the first path segment is the workshop id, and that
-- is what the policy checks.
do $do$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;   -- local test Postgres has no storage schema; nothing to do
  end if;

  insert into storage.buckets (id, name, public) values ('partner-receipts', 'partner-receipts', false)
  on conflict (id) do nothing;

  execute 'drop policy if exists "partner receipts read"  on storage.objects';
  execute 'drop policy if exists "partner receipts write" on storage.objects';
  execute 'drop policy if exists "partner receipts wipe"  on storage.objects';

  execute $p$
    create policy "partner receipts read" on storage.objects for select to authenticated
    using (bucket_id = 'partner-receipts'
      and (app.is_rr_admin()
           or nullif((storage.foldername(name))[1], '')::uuid = app.user_workshop_id()))
  $p$;
  execute $p$
    create policy "partner receipts write" on storage.objects for insert to authenticated
    with check (bucket_id = 'partner-receipts'
      and (app.is_rr_admin()
           or nullif((storage.foldername(name))[1], '')::uuid = app.user_workshop_id()))
  $p$;
  execute $p$
    create policy "partner receipts wipe" on storage.objects for delete to authenticated
    using (bucket_id = 'partner-receipts'
      and (app.is_rr_admin()
           or nullif((storage.foldername(name))[1], '')::uuid = app.user_workshop_id()))
  $p$;
end $do$;
