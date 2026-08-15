-- 0482_creditors_by_supplier.sql
-- The payables ageing, grouped by the business rather than by the spelling.
--
-- 0460's `app.partner_creditors` groups by `btrim(supplier_name)`, which was the only
-- thing available to it at the time and which has one consequence the screen cannot hide:
-- "Agri Diesel" and "Agri diesel " are two rows owed money, and the partner reading "who
-- do I owe" adds them up by eye. Now that 0480 gives the supplier an identity and 0481
-- attaches the history to it, the ageing can group by the record.
--
-- ── Same shape, deliberately ─────────────────────────────────────────────────
--
-- The returned columns and the bucket boundaries are UNCHANGED — `supplier`, four buckets,
-- a total; current is 0–30 days from the supplier's own invoice date, then 31–60, 61–90,
-- over 90. /money renders this and its CSV reads it, and a report that quietly changes
-- shape underneath a screen is how a figure stops being believed. Only the grouping moves.
--
-- ── Falling back to the name is not a temporary state ────────────────────────
--
-- 0481 refuses to invent a supplier for an unknown name, so unlinked expenses are normal
-- and permanent for any workshop that never files its suppliers. Those still have to age,
-- and they still have to merge across case and padding — so the fallback key is the
-- lower-trimmed name, which fixes the original complaint even where nothing was filed.
-- Prefixing it (`name:`) keeps a free-text group from ever colliding with a uuid group.
--
-- ── Why the label comes from the record ─────────────────────────────────────
--
-- When a supplier is linked, the row is titled with the RECORD's name, not with whatever
-- was typed on the newest invoice. That is what makes the merge visible: three spellings
-- become one line under the name the partner chose for the business. The join is a LEFT
-- one and RLS applies to it (SECURITY INVOKER, as 0460 set out), so a supplier the caller
-- cannot see — soft-deleted, or another workshop's — yields no name and the row falls back
-- to its free text rather than disappearing. Money owed must never vanish from a payables
-- report because a lookup came back empty.

create or replace function app.partner_creditors(p_workshop uuid, p_as_at date default current_date)
returns table (
  supplier      text,
  current_cents bigint,
  d30_cents     bigint,
  d60_cents     bigint,
  d90_cents     bigint,
  total_cents   bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with unpaid as (
    select coalesce(s.id::text, 'name:' || lower(btrim(coalesce(e.supplier_name, '')))) as grp,
           coalesce(nullif(btrim(s.name), ''), nullif(btrim(e.supplier_name), ''), '—')  as label,
           (e.amount_cents + e.vat_cents) as owed,     -- what actually leaves the bank
           p_as_at - e.expense_date as age
      from partner_expenses e
      left join suppliers s
        on s.id = e.supplier_id and s.workshop_id = e.workshop_id
     where e.workshop_id = p_workshop
       and e.deleted_at is null
       and e.paid_on is null
       and e.expense_date <= p_as_at
  )
  -- `min(label)` only ever has a choice to make inside a fallback group, where the same
  -- unfiled business was typed several ways; a linked group has one record and therefore
  -- one name. Choosing deterministically matters anyway — a heading that changes between
  -- two page loads reads as a bug in the numbers underneath it.
  select min(label),
         coalesce(sum(owed) filter (where age <= 30), 0)::bigint,
         coalesce(sum(owed) filter (where age between 31 and 60), 0)::bigint,
         coalesce(sum(owed) filter (where age between 61 and 90), 0)::bigint,
         coalesce(sum(owed) filter (where age > 90), 0)::bigint,
         coalesce(sum(owed), 0)::bigint
    from unpaid
   group by grp
  having coalesce(sum(owed), 0) > 0
   order by 6 desc;
$$;

comment on function app.partner_creditors(uuid, date) is
  'Payables ageing (0460), grouped by the SUPPLIER RECORD where one is linked (G18, 0480) '
  'and by the trimmed lower-cased name where none is. Same columns and buckets as before — '
  '/money renders this — so only the grouping changed.';

-- The wrapper is unchanged in shape and simply re-stated, so the API surface is visibly
-- the same file-to-file. `create or replace` keeps existing privileges, but the grants are
-- re-run below anyway: G11 fails the suite for any app-schema function anon can execute,
-- and "it was already correct" is not something a migration should assume.
create or replace function public.partner_creditors(p_workshop uuid, p_as_at date default current_date)
returns table (
  supplier text, current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_creditors(p_workshop, p_as_at);
$$;

do $do$
declare f text;
begin
  foreach f in array array['app.partner_creditors(uuid,date)', 'public.partner_creditors(uuid,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
