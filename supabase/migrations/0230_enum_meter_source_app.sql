-- 0230_enum_meter_source_app.sql  (F3 · field capture & accountability)
-- Extend the meter_source enum with `app` so in-app driver-usage captures can be
-- distinguished from qr/job/manual/whatsapp sources.
--
-- `ALTER TYPE ... ADD VALUE` must live in its own migration step: the new value
-- cannot be *used* (in a default, comparison or insert) inside the same transaction
-- that adds it. Kept alone here; the table that stores it lands in 0233.
alter type meter_source add value if not exists 'app';
