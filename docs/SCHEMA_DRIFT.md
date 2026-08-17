# Checking the live database against this repo

`pnpm db:test` builds a database **from** `supabase/migrations/` and runs the isolation
suite against it. That proves the repo is sound. It cannot prove anything about the live
project, because an object created directly on production — by hand, in the SQL editor,
during a debugging session — does not exist in the migrations and so is invisible to the
test.

That gap is not theoretical. `public._f14_probe(uuid)` was created on the live project
during F14 to answer "what does this user see?", was never removed, and survived an
entire session of green tests. It was `SECURITY INVOKER`, so it did not bypass RLS — it
called `set_config('request.jwt.claims', …)` with a uuid **the caller chose**, and every
policy in this schema decides through `auth.uid()`. It therefore did not switch the fence
off; it moved the caller to the other side of it and let RLS answer correctly on somebody
else's behalf. Measured before removal: a Weltevrede operator, who legitimately reads zero
partner documents, read back another tenant's document counts. Migration `0440` drops it.

This document is how to make sure nothing like it is there now.

---

## Run it

`scripts/schema_fingerprint.sql` prints one line per object — `kind  name  md5` — for ten
categories: columns, constraints, enums, functions, **function grants**, indexes,
policies, RLS flags, table grants, triggers. Roughly 940 lines.

### 1. Fingerprint the repo

Build a throwaway database from the migrations and fingerprint it:

```bash
createdb fleetwise_fp
psql -q -d fleetwise_fp -f supabase/tests/shim/auth_shim.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -d fleetwise_fp -f "$f"; done
psql -tA -d fleetwise_fp -f scripts/schema_fingerprint.sql > /tmp/fp_repo.txt
```

### 2. Fingerprint production

With a direct connection (Supabase → Project Settings → Database → connection string):

```bash
psql -tA "$SUPABASE_DB_URL" -f scripts/schema_fingerprint.sql > /tmp/fp_live.txt
```

With no direct connection, paste the contents of `scripts/schema_fingerprint.sql` into the
Supabase **SQL editor** and export the result. The file is deliberately pure SQL — no
psql meta-commands — so this works.

### 3. Diff

```bash
diff /tmp/fp_repo.txt /tmp/fp_live.txt && echo "no drift"
```

`<` lines are in the repo but missing from production (a migration that never ran).
`>` lines exist only on production (**this is the dangerous direction** — something was
created by hand). A changed hash on the same name is a definition that differs.

To drill into one object, read its definition on both sides: `pg_get_functiondef(oid)` for
a function, `pg_get_constraintdef` / `pg_get_triggerdef`, or `pg_policies` for a policy.

---

## Reading the output honestly

Three normalisations are built in, each earned by chasing a difference that was not a
difference. If you write your own comparison, you will hit all three:

1. **Carriage returns are stripped.** Postgres stores a function body verbatim. A CRLF
   checkout (any Windows clone) puts `\r` on every line of every function body. It is
   whitespace to the parser and invisible in psql output, but it changes the hash of all
   111 functions at once.
2. **SQL line comments are stripped.** Migrations applied by pasting into the SQL editor
   can arrive with comments removed. Production currently has no comments in its function
   bodies for exactly this reason. Nothing about behaviour differs.
3. **Ordering is forced to the `C` collation.** The default collation differs between a
   local cluster and the hosted one, and `_` and `.` sort differently under each — so
   identical object sets aggregate to different hashes if you let the server choose.

Nothing *semantic* is normalised. Two function bodies differing by one operator hash
differently and show up.

One caveat worth knowing: a mismatched `PGCLIENTENCODING` on Windows turns the em-dashes
in this codebase's error messages into mojibake as the migrations load, which shows up as
four functions differing for no visible reason. Export `PGCLIENTENCODING=UTF8` before
loading.

That caveat has now cost real time twice, so here is the concrete instance to recognise it
by. A comparison found exactly one function differing: `app.partner_creditors`, 1,322 chars
on production against 1,693 in the repo. Most of the gap was stripped comments (point 2
above, normalised). The rest was **one character**: the fallback label for an expense with
no supplier name at all was `'-'` on production where the repo has `'—'`. An earlier session
had loaded `0482` through psql without `PGCLIENTENCODING=UTF8`. It is cosmetic — but note
that the fingerprint deliberately did **not** normalise it away, because a character inside
a string literal is semantic and the next one might not be cosmetic. Re-stating the repo's
version through a migration closed it.

The useful technique when one category disagrees: **bisect, do not transcribe.** Group the
digest by schema (two groups), then by `left(proname,1)` (seventeen), and only enumerate the
bucket that differs. That found the single function above in three queries instead of
diffing 157 bodies.

---

## When to run it

- Before trusting any claim of the form "production has every migration applied".
- After anyone touches the live database outside a migration.
- After a restore (see `BACKUP.md`) — a PITR rewind can undo a migration silently.

The comparison that found `_f14_probe` is recorded in the status block in `CLAUDE.md`; after
`0440`, all ten categories matched across 937 objects.

The most recent one, after the voice-assistant migrations and `0490–0492` were applied,
matches across **1,256 objects** in all ten categories:

```
column           59  e35c412910de52a2      index           225  629abfd3e8298d03
constraint      332  1f782a37b8cf8621      policy           58  a701e01c59324208
enum             41  c7eeac473fc85185      rls              59  b3dc8b2899c9cb4e
function        157  7543983a99f144bf      table-grant      58  87d03f9ae0835e4b
function-grant  157  8e49a8857fa91d81      trigger         105  9a345f5abb1e5372
```

When comparing, remember the repo side is a *test* database: `rls_isolation.sql` creates
five helpers of its own (`_t_login`, `_t_assert`, `_t_notif`, `_h2_fault_args`,
`_h2_reading_args`). They are the difference between 1,261 local objects and 1,256, and they
must never appear on production. Exclude them with `proname !~ '^_(t|h2)_'`.

## What this does not cover

Data, Storage bucket policies, Auth settings (the leaked-password toggle lives there), and
the `supabase_migrations` ledger, which on this project lists fewer entries than the repo
has files because several were applied by pasting combined content. The ledger being short
is cosmetic; what matters is whether the *objects* match, which is what this measures.
