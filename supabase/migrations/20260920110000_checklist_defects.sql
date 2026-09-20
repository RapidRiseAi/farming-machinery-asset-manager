-- 20260920110000_checklist_defects.sql
-- A failed pre-start check has to reach somebody.
--
-- THE GAP
-- ─────────────────────────────────────────────────────────────────────────────
-- Checklists (F11, 0290) record answers and nothing more. The field types are
-- checkbox / text / number / photo / rating / section_break, and none of them carries the
-- idea of a DEFECT. So a driver can tick "Brakes: no" at six in the morning, the checklist
-- saves, and the farm learns about it when something goes wrong: no fault, no alert, no
-- trace on the machine's open issues. The whole point of a pre-start inspection is the
-- exception it catches.
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────────────────────
-- A template field can now say WHICH answer is a defect (`fail_when`), how bad it is
-- (`fail_urgency`), and — for numbers and ratings — the threshold (`fail_threshold`).
-- `public.record_checklist_defects(instance)` reads a filled checklist, opens ONE fault per
-- failing answer, and stamps the instance so it can never open them twice.
--
-- WHY A SEPARATE COMMAND RATHER THAN A TRIGGER
-- ─────────────────────────────────────────────────────────────────────────────
-- A checklist is saved in three steps — the instance, then any photos, then the values —
-- so a trigger on the instance would run before a single answer existed. The action calls
-- this once the answers are in. It is idempotent (`defects_raised_at`), so the offline
-- replay and a retried submit cannot raise the same fault twice.
--
-- IT DOES NOT TAKE THE MACHINE OUT OF SERVICE
-- ─────────────────────────────────────────────────────────────────────────────
-- Deliberately. Changing a machine's status is owner/manager work (`machines_upd`), and a
-- driver filling in a checklist is usually an operator. The fault carries the urgency, the
-- existing fault → out-of-service action (F3) stays where it is, and nobody is quietly
-- given a permission by way of a checklist.

-- ── What counts as a defect ─────────────────────────────────────────────────
alter table public.checklist_template_fields
  add column if not exists fail_when text,
  add column if not exists fail_threshold numeric(12,2),
  add column if not exists fail_urgency fault_urgency;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'checklist_template_fields_fail_when_ck'
  ) then
    alter table public.checklist_template_fields
      add constraint checklist_template_fields_fail_when_ck
      check (fail_when is null or fail_when in ('checked','unchecked','below','above'));
  end if;
end $$;

comment on column public.checklist_template_fields.fail_when is
  'Which answer is a defect: checked / unchecked for a checkbox, below / above a '
  'fail_threshold for a number or rating. Null means this field never raises anything.';

-- ── So the same checklist cannot raise its faults twice ─────────────────────
alter table public.checklist_instances
  add column if not exists defects_raised_at timestamptz;

-- ── Which checklist a fault came from ───────────────────────────────────────
alter table public.faults
  add column if not exists checklist_instance_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'faults_checklist_instance_fk'
  ) then
    alter table public.faults
      add constraint faults_checklist_instance_fk
      foreign key (checklist_instance_id, farm_id)
      references public.checklist_instances(id, farm_id);
  end if;
end $$;
create index if not exists faults_checklist_instance_idx
  on public.faults(checklist_instance_id) where checklist_instance_id is not null;

-- ── Open a fault for every failed answer ────────────────────────────────────
--
-- SECURITY INVOKER: filling in a checklist and reporting a fault are the same person's
-- work, and `faults_ins` already allows every farm-side role on a machine they can see.
-- So RLS decides here too, and an operator raising a defect on their own tractor is
-- exactly the path the policy was written for.
create or replace function public.record_checklist_defects(p_instance uuid)
returns integer
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_farm uuid;
  v_machine uuid;
  v_name text;
  v_raised timestamptz;
  v_count integer := 0;
  r record;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select ci.farm_id, ci.machine_id, ci.template_name, ci.defects_raised_at
    into v_farm, v_machine, v_name, v_raised
    from public.checklist_instances ci
   where ci.id = p_instance
     and ci.deleted_at is null
     and ci.status = 'completed'
   for update;
  if not found then
    -- A draft raises nothing: it is not finished being filled in.
    return 0;
  end if;
  if v_raised is not null then
    -- Already done. A retried submit or an offline replay must not report the same
    -- broken brake twice.
    return 0;
  end if;

  for r in
    select v.label,
           v.notes,
           coalesce(f.fail_urgency, 'limping'::fault_urgency) as urgency
      from public.checklist_instance_values v
      join public.checklist_template_fields f on f.id = v.template_field_id
     where v.instance_id = p_instance
       and v.deleted_at is null
       and f.fail_when is not null
       and (
         (f.fail_when = 'checked'
            and lower(coalesce(v.value_text, '')) in ('true','t','yes','1','on'))
         or (f.fail_when = 'unchecked'
            and lower(coalesce(v.value_text, '')) not in ('true','t','yes','1','on'))
         or (f.fail_when = 'below'
            and f.fail_threshold is not null
            and v.value_text ~ '^-?[0-9]+(\.[0-9]+)?$'
            and v.value_text::numeric < f.fail_threshold)
         or (f.fail_when = 'above'
            and f.fail_threshold is not null
            and v.value_text ~ '^-?[0-9]+(\.[0-9]+)?$'
            and v.value_text::numeric > f.fail_threshold)
       )
     order by v.sort_order, v.label
  loop
    insert into public.faults(
      farm_id, machine_id, reported_by, description, category, urgency, status,
      checklist_instance_id
    ) values (
      v_farm, v_machine, auth.uid(),
      -- The checklist and the answer that failed, so the fault reads like the inspection:
      -- "Daily pre-start — Brakes" and then whatever the driver wrote.
      left(format('%s — %s%s', coalesce(v_name, 'Checklist'), r.label,
             case when coalesce(btrim(r.notes), '') = '' then ''
                  else format(': %s', r.notes) end), 1000),
      'checklist', r.urgency, 'open', p_instance
    );
    v_count := v_count + 1;
  end loop;

  update public.checklist_instances
     set defects_raised_at = now()
   where id = p_instance
     and farm_id = v_farm;

  return v_count;
end $$;

revoke execute on function public.record_checklist_defects(uuid) from public, anon;
grant execute on function public.record_checklist_defects(uuid) to authenticated, service_role;

comment on function public.record_checklist_defects(uuid) is
  'Opens one fault per failed answer on a completed checklist, once. Idempotent through '
  'checklist_instances.defects_raised_at, so an offline replay cannot duplicate a defect.';
