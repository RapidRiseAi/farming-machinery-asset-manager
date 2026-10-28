-- Finance history is read by the people who may read finance (integrating 20261028090000
-- with 20261028110100).
--
-- The activity log files each audited table by a rule: 'farm' (the farm's whole log, read
-- by its owners, managers and mechanics) or 'rapid_rise' (farm_id null, the farm kept in
-- about_farm_id). Finance agreements, their instalments and asset contracts fit neither.
-- They are narrower than the farm's log (mechanics must not read them: lenders, balances
-- and rates are not a mechanic's business, app.can_view_farm_finance), yet the owner and
-- manager who keep them should see who changed what. Unruled, they were filed for Rapid
-- Rise only (fail closed), so the farm lost the history of its own agreements.
--
-- So a third scope, 'finance': filed exactly as 'rapid_rise' is (app.audit_log_file files
-- everything that is not 'farm' with farm_id null and the farm in about_farm_id, unchanged
-- here), and readable as well by whoever app.can_view_farm_finance allows on that farm
-- (app.finance_readable_farm_ids, from the finance package).
-- The new branch of audit_sel reads about_farm_id only for entities whose rule is
-- 'finance'; every other refiled row stays Rapid Rise only, as before.

alter table app.audit_table_rules drop constraint if exists audit_table_rules_scope_check;
alter table app.audit_table_rules
  add constraint audit_table_rules_scope_check check (scope in ('farm', 'rapid_rise', 'finance'));

comment on table app.audit_table_rules is
  'Where each audited public table files its audit_log rows: farm (under the row''s farm, read '
  'by its owners, managers and mechanics), rapid_rise (farm_id null, Rapid Rise only) or '
  'finance (filed as rapid_rise, and read as well by those app.can_view_farm_finance allows on '
  'the farm, 20261028120000). A table with no row is filed for Rapid Rise (fail closed).';

insert into app.audit_table_rules (table_name, scope, reason) values
  ('finance_agreements', 'finance',
   'Lender, balance and rate: owners and managers only (app.can_view_farm_finance), never mechanics, operators or contractors.'),
  ('finance_instalments', 'finance',
   'The schedule of a finance agreement: the same readers as the agreement.'),
  ('asset_contracts', 'finance',
   'Leases, rentals and service contracts: the same readers as finance agreements.')
on conflict (table_name) do update set scope = excluded.scope, reason = excluded.reason;

-- audit_sel as 20261028092000 left it, plus the finance branch.
drop policy if exists audit_sel on public.audit_log;
create policy audit_sel on public.audit_log for select to authenticated
  using (
    (select app.is_rr_admin())
    or farm_id in (select app.audit_readable_farm_ids())
    or (
      entity = 'machines'
      and farm_id = any (array(select app.audit_vehicle_reader_farm_ids()))
      -- Runs under machines' own policy, as the caller: the vehicles they can see.
      and entity_id in (
        select m.id from public.machines m
         where m.farm_id = any (array(select app.audit_vehicle_reader_farm_ids()))
      )
    )
    or (
      farm_id is null
      and entity in ('finance_agreements', 'finance_instalments', 'asset_contracts')
      and about_farm_id = any (array(select app.finance_readable_farm_ids()))
    )
  );

-- The finance package's own guard (20261028110100) is a RESTRICTIVE policy that let a reader
-- see finance rows only where farm_id is a farm they may read finance on. Refiled rows have
-- farm_id null, so it shut out the owner and manager as well. The same rule, reading the
-- farm from about_farm_id when the row was refiled; still narrowing whatever audit_sel says.
drop policy if exists audit_finance_disclosure on public.audit_log;
create policy audit_finance_disclosure on public.audit_log
  as restrictive for select to authenticated
  using (
    (select app.is_rr_admin())
    or coalesce(farm_id, about_farm_id) in (select app.finance_readable_farm_ids())
    or not (
      entity in ('finance_agreements', 'finance_instalments', 'asset_contracts')
      or (entity = 'attachments'
          and coalesce(diff -> 'new' ->> 'parent_type', diff -> 'old' ->> 'parent_type')
              in ('finance_agreement', 'asset_contract'))
    )
  );
