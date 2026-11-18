-- 20261119120000_service_template_once.sql
-- A service template is applied to a machine once (task B3, repeat-tap follow-up).
--
-- Applying a template read the machine's plan lines and inserted the tasks it did not have.
-- Two presses at once (a double tap, two tabs, a retry after a lost answer) both read the
-- plan before either wrote, and both inserted every line: a doubled service plan, each
-- line falling due twice. A screen guard does not stop that; the database now does. The
-- line remembers the template it came from, and one machine holds each template task once.
--
-- Additive: a nullable column (existing lines keep null and are not judged) and a partial
-- unique index over rows that carry a template, which no existing row does, so it cannot
-- fail on live data. Lines added by hand are never constrained by it.

alter table public.service_plan_lines
  add column if not exists template_id uuid references public.service_templates(id) on delete set null;

create unique index if not exists service_plan_lines_template_once
  on public.service_plan_lines (machine_id, template_id, lower(btrim(task)))
  where template_id is not null and deleted_at is null;
