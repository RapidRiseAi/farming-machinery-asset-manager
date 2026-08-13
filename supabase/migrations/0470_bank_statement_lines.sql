-- 0470_bank_statement_lines.sql
-- G15a — The bank statement, brought inside.
--
-- Customers pay by EFT, and that happens entirely outside this product. So today the ONLY
-- way an invoice ever becomes "paid" is a human opening internet banking on one screen,
-- opening FleetWise on another, and typing what they can see. That is the chore this
-- feature removes, and it is worth being precise about why it is worth removing: it is not
-- slow, it is UNRELIABLE. A partner who is behind on it has a debtors list that chases
-- people who already paid, an ageing report that is wrong, and a statement that will be
-- argued with. Every downstream number in G1–G14 is only as true as this typing.
--
-- WHAT THIS TABLE IS NOT. It is not the ledger. A bank line is a claim by the bank that
-- money moved; the ledger entry is `partner_payments` (money in) or `partner_expenses.
-- paid_on` (money out), and those stay exactly where they are with exactly the triggers
-- they already have. Importing a statement writes nothing to the books — it only puts a
-- list of candidate facts next to them. Nothing is ever settled without a person pressing
-- a button (0471/0472 carry the settlement links).
--
-- SIGN CONVENTION. `amount_cents` is SIGNED: positive is money into the partner's account,
-- negative is money out. One column rather than the debit/credit pair most bank exports
-- use, because two columns means every reader has to remember which one is which and one
-- of them will eventually get it wrong. The importer normalises whichever shape the bank
-- gave it into this single signed integer, in cents, with no float arithmetic anywhere.
--
-- Scope: WORKSHOP, exactly like `partner_expenses` (0430) and `partner_clients` (0390).
-- A bank statement is the most sensitive document a small business has — it shows every
-- customer who paid, every supplier, every salary and every personal transfer — so there
-- is no farm path in these policies at all, not even for a farm the partner works for.

-- ── The batch a line arrived in ──────────────────────────────────────────────
-- Kept as its own row rather than a text column on every line, for two reasons that both
-- matter when something goes wrong: a partner needs to see "I have loaded January twice
-- and March not at all", and when a figure looks wrong the first question is always which
-- file it came from. The counts are recorded at import time because they are a statement
-- about that IMPORT ("30 rows, 12 were new"), not a live property of the table — recomputing
-- them later would silently change what the partner was told at the time.
create table bank_statement_imports (
  id            uuid primary key default gen_random_uuid(),
  workshop_id   uuid not null references workshops(id) on delete cascade,

  file_name     text,
  -- Free text on purpose. A partner with a cheque account and a credit card needs to tell
  -- the two apart, and asking them to configure an "account" entity first is how an import
  -- screen stops being used. Whatever they type is what they will recognise.
  account_label text,

  rows_in_file  int not null default 0,
  rows_added    int not null default 0,

  imported_at   timestamptz not null default now(),
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid
);

create index bank_statement_imports_workshop_idx
  on bank_statement_imports(workshop_id, imported_at desc);

-- ── What state a line is in ──────────────────────────────────────────────────
-- Three, and no more. `ignored` is the one that earns its place: a statement is full of
-- lines that will never reconcile against anything in here — bank charges, a transfer to
-- the owner's own savings, the monthly debit order for the premises rent captured as an
-- expense in a different month. Without a way to say "this one is dealt with, stop showing
-- it to me", the unmatched list grows for ever and the partner stops opening the screen,
-- which is the failure this whole feature exists to prevent.
create type bank_line_status as enum ('unmatched', 'matched', 'ignored');

create table bank_lines (
  id            uuid primary key default gen_random_uuid(),
  workshop_id   uuid not null references workshops(id) on delete cascade,
  import_id     uuid references bank_statement_imports(id) on delete set null,

  txn_date      date not null,
  description   text,
  reference     text,

  -- Signed, integer cents, as it appeared on the statement. Deliberately NOT split into
  -- ex-VAT and VAT: a bank line has no VAT. It is a movement of cash, and the VAT belongs
  -- to the invoice or the supplier document it settles, which is already recorded there.
  amount_cents  bigint not null,

  -- Where this line sat in the file. Not decoration: when a partner is looking at two
  -- lines that are identical in every visible way, "row 44" is how they tell them apart.
  row_no        int,

  -- The nth identical transaction within its own statement — see the unique index below.
  occurrence    int not null default 1,

  -- The comparable form of the free text, computed by the DATABASE so that the dedupe key
  -- cannot drift with whatever the importer happened to do that day. Case, spacing and
  -- punctuation all vary between two exports of the same statement (banks pad reference
  -- columns, some quote them, some collapse double spaces), and none of those differences
  -- mean it is a different transaction.
  fingerprint   text generated always as (
    lower(regexp_replace(coalesce(description, '') || ' ' || coalesce(reference, ''),
                         '[^a-zA-Z0-9]+', '', 'g'))
  ) stored,

  status        bank_line_status not null default 'unmatched',
  -- What it was matched TO, kept here so the screen can render a matched line without a
  -- second query. These are maintained by the 0472 trigger from the settlement rows, never
  -- typed by a caller — if they were typed, a soft-deleted payment would leave a bank line
  -- claiming to be settled by something that no longer exists.
  matched_document_id uuid references partner_documents(id) on delete set null,
  matched_payment_id  uuid references partner_payments(id)  on delete set null,
  matched_expense_id  uuid references partner_expenses(id)  on delete set null,
  matched_at    timestamptz,
  -- There is deliberately no `matched_by`. It would have to be written by the confirm
  -- action rather than derived like everything else on this row, and it would duplicate
  -- something the append-only `audit_log` already records for every update — including the
  -- ones a future code path makes without remembering this column exists.

  note          text,

  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid,

  -- A zero-value bank line is a formatting accident (a balance-brought-forward row, a
  -- header the parser mistook for data), never a transaction.
  constraint bank_lines_amount_ck check (amount_cents <> 0),
  constraint bank_lines_occurrence_ck check (occurrence >= 1),
  -- A line settles ONE thing. Money in settles an invoice, money out settles a supplier
  -- bill; a row claiming both would be a bug in the settlement path, and it is cheaper to
  -- refuse it here than to find it later in a total that will not add up.
  constraint bank_lines_one_settlement_ck check (
    matched_payment_id is null or matched_expense_id is null
  )
);

create index bank_lines_workshop_idx on bank_lines(workshop_id, txn_date desc);
create index bank_lines_open_idx     on bank_lines(workshop_id, status, txn_date desc)
  where deleted_at is null;
create index bank_lines_import_idx   on bank_lines(import_id, row_no);

-- ══════════════════════════════════════════════════════════════════════════════
-- Re-importing the same statement must not duplicate anything
-- ══════════════════════════════════════════════════════════════════════════════
-- This is the property that decides whether the feature is usable at all. A partner WILL
-- re-upload: they download a fresh statement every Friday and each one overlaps the last,
-- they retry after a bad column mapping, they forward the file to a bookkeeper who loads
-- it again. If that produces a second copy of every line, the unmatched list doubles and
-- the partner is worse off than before they started.
--
-- It is enforced with a UNIQUE INDEX and not with a "does this already exist?" check in the
-- import action, because a check-then-insert loses races. Two tabs, a double-tapped button
-- on a phone, or a retried server action run the check concurrently, both see nothing, and
-- both insert. The database is the only place that can decide this correctly.
--
-- The key is the natural identity of a transaction: whose account, what day, how much, and
-- the text the bank printed against it. `occurrence` is what stops that key being WRONG in
-- the one case where it would be: a business genuinely can be charged the same R50 card fee
-- twice on the same day with identical narrative. Those are two real transactions, and
-- collapsing them would understate the month. The importer numbers identical tuples 1, 2,
-- 3… within the file it is loading — which is deterministic, so the same file re-imported
-- produces the same numbers and collides, while a second genuine occurrence takes the next
-- number and survives.
--
-- The index deliberately covers deleted rows too. "Remove this line" therefore means it
-- stays gone across future imports of the same statement, which is what a person pressing
-- remove means; a partial index would resurrect it on every subsequent upload.
create unique index bank_lines_natural_uq
  on bank_lines (workshop_id, txn_date, amount_cents, fingerprint, occurrence);

comment on table bank_lines is
  'One line off a bank statement (G15). Workshop-scoped: a statement names every customer, '
  'supplier and salary the partner has, so no farm path exists in these policies. '
  'amount_cents is SIGNED — positive in, negative out — and this table is never the ledger: '
  'settlement is a partner_payments row or partner_expenses.paid_on, confirmed by a person.';

comment on column bank_lines.occurrence is
  'The nth identical (date, amount, text) transaction within its own statement. Exists so '
  'the natural-key unique index can refuse a re-import without also refusing two genuinely '
  'identical charges on the same day.';

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS: the partner's own bank, and nobody else's
-- ══════════════════════════════════════════════════════════════════════════════
-- Character-for-character the 0430 shape: own workshop or rr_admin, no farm helper anywhere
-- near it. anon gets nothing — 0102 revokes the default privileges and no anon policy
-- exists, so an unauthenticated request has no route to these rows at all.
alter table bank_statement_imports enable row level security;
alter table bank_statement_imports force  row level security;

create policy bank_statement_imports_sel on bank_statement_imports for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy bank_statement_imports_ins on bank_statement_imports for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy bank_statement_imports_upd on bank_statement_imports for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy bank_statement_imports_del on bank_statement_imports for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

alter table bank_lines enable row level security;
alter table bank_lines force  row level security;

create policy bank_lines_sel on bank_lines for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy bank_lines_ins on bank_lines for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy bank_lines_upd on bank_lines for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy bank_lines_del on bank_lines for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

grant select, insert, update, delete on bank_statement_imports to authenticated;
grant all on bank_statement_imports to service_role;
grant select, insert, update, delete on bank_lines to authenticated;
grant all on bank_lines to service_role;

create trigger bank_statement_imports_audit
  after insert or update or delete on bank_statement_imports
  for each row execute function app_audit();
create trigger bank_lines_audit
  after insert or update or delete on bank_lines
  for each row execute function app_audit();
