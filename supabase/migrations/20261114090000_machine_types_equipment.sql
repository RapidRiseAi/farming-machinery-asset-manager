-- 20261114090000_machine_types_equipment.sql
-- Three kinds of support equipment the founder named that had no type of their own
-- (decision register of 12 November 2026, decisions 1 and 4): compressors, workshop tools,
-- and other equipment that is not self-propelled (a welder rig, an irrigation pivot, a cold
-- room). Pumps and generators already share `pump_generator`, unpowered attachments are
-- `implement`, trailers are `trailer`.
--
-- On its own because an enum value cannot be added and used in one transaction
-- (CLAUDE.md, Postgres "unsafe use of new value"): 20261114090100 uses them.
--
-- Safe on live data: adding enum values rewrites nothing and changes no existing row.

alter type public.machine_type add value if not exists 'compressor';
alter type public.machine_type add value if not exists 'workshop_tool';
alter type public.machine_type add value if not exists 'other_equipment';
