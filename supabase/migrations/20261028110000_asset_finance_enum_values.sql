-- 20261028110000_asset_finance_enum_values.sql
-- Machinery finance and lease tracking (work package C, 2026-10-28): the enum values the
-- migrations after this one use.
--
-- An enum value cannot be added and used in one transaction (Postgres answers "unsafe use
-- of new value"), and the runner applies one file per transaction, so the values live here
-- on their own and nothing in this file uses them.
--
--   cost_entry_type 'lease'          a lease or rental payment booked as it falls due
--                                    (20261028110400). Interest keeps the existing
--                                    'finance' type; capital is never a cost entry.
--   calendar_item_kind 'finance_instalment', 'contract_notice', 'contract_end'
--                                    the dates the farm calendar learns (20261028110900).

alter type public.cost_entry_type add value if not exists 'lease';

alter type public.calendar_item_kind add value if not exists 'finance_instalment';
alter type public.calendar_item_kind add value if not exists 'contract_notice';
alter type public.calendar_item_kind add value if not exists 'contract_end';
