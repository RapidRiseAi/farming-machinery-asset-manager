-- The recurring invoice generator locks each schedule it raises (interaction safety follow-up).
--
-- Its loop read due schedules without a lock. The nightly cron and a partner's "raise it now"
-- (or two cron runs) at the same moment could both read a schedule as due, before either had
-- written its new last_period_start, and both raise an invoice: the customer billed twice.
-- The recurring EXPENSE generator already takes `for update of re` (0483); this gives the
-- invoice generator the same. A second run now waits for the first, then reads the schedule
-- as it was left (next_issue_date moved on) and passes it by.
--
-- Rewritten in place from the live definition, the way 20260927160340 does, so nothing else in
-- the function can drift; it stops if the text it expects is not there.
do $migration$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('app.generate_recurring_invoices(uuid)'::regprocedure);
  if position('for update of ri' in v_def) > 0 then
    return; -- already applied
  end if;
  v_new := regexp_replace(
    v_def,
    '(f\.status in \(''trial'', ''active''\)\)\))(\s+loop)',
    E'\\1\n       for update of ri\\2'
  );
  if v_new = v_def or position('for update of ri' in v_new) = 0 then
    raise exception 'generate_recurring_invoices: the loop query was not where expected; not changed';
  end if;
  execute v_new;
end
$migration$;
