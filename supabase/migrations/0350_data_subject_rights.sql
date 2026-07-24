-- 0350_data_subject_rights.sql  (F8 · POPIA NFR-3 — data-subject access & erasure)
--
-- Two guarded SECURITY DEFINER RPCs implementing the POPIA data-subject rights of
-- ACCESS (export) and ERASURE (anonymise) for a person whose personal data we hold.
-- See docs/POPIA.md for the personal-data inventory, lawful bases, and the
-- anonymise-not-hard-delete rationale.
--
-- Access model (identical for both RPCs):
--   * rr_admin                         → any person (cross-tenant; the access is logged)
--   * a farm's owner / manager         → only people belonging to THEIR farm
--   * everyone else / anon             → denied (execute revoked below)
-- The functions are SECURITY DEFINER so they can read/anonymise across the personal
-- tables and write the append-only audit_log regardless of the caller's RLS; the guard
-- block at the top of each is the sole authority on WHO may act on WHOM.
--
-- Why anonymise, not DELETE (POPIA erasure done safely):
--   `public.users.id` is referenced (RESTRICT) by meter_readings.by_user,
--   faults.reported_by/assigned_to, job_cards.mechanic_user_id/approved_by,
--   cost_entries.created_by, attachments.created_by, notifications.user_id, and by
--   usage_logs.driver_user_id — the AARTO driver-usage record we are legally obliged to
--   retain. A hard DELETE would either fail or destroy maintenance/finance/AARTO history.
--   So erasure ANONYMISES the identifying fields in-place (name/email/phone cleared, the
--   account deactivated + soft-deleted) and nulls the free-text name COPIES elsewhere,
--   leaving the de-identified structural history intact. The append-only audit_log is
--   retained under the legal-obligation / audit-integrity basis (documented in POPIA.md).

-- ─────────────────────────────────────────────────────────────────
-- Shared guard: may the current user act on p_user's personal data?
-- Returns the subject's farm_id (may be null for rr_admin/workshop subjects) and
-- raises if the caller is not entitled. Logs rr_admin cross-tenant access.
-- ─────────────────────────────────────────────────────────────────
create or replace function app.assert_can_manage_person(p_user uuid, p_action text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_subject_farm uuid;
  v_exists       boolean;
begin
  select true, farm_id into v_exists, v_subject_farm
    from public.users where id = p_user;
  if not coalesce(v_exists, false) then
    raise exception 'unknown data subject';
  end if;

  if app.is_rr_admin() then
    -- Cross-tenant support access is always logged (Scope §4.9 pattern).
    insert into audit_log(farm_id, user_id, entity, entity_id, action, diff)
    values (v_subject_farm, auth.uid(), 'data_subject_' || p_action, p_user, p_action,
            jsonb_build_object('by', auth.uid(), 'subject', p_user, 'rr_admin', true, 'at', now()));
    return v_subject_farm;
  end if;

  if v_subject_farm is null
     or not exists (
       select 1 from public.users me
       where me.id = auth.uid() and me.role in ('owner','manager')
         and me.farm_id = v_subject_farm and me.active and me.deleted_at is null
     ) then
    raise exception 'not allowed to % this person''s personal data', p_action;
  end if;

  return v_subject_farm;
end $$;

revoke execute on function app.assert_can_manage_person(uuid, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- ACCESS (Data Subject Access Request): export everything we hold on a person.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.export_personal_data(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm uuid;
  v_out  jsonb;
begin
  v_farm := app.assert_can_manage_person(p_user, 'export');

  select jsonb_build_object(
    'generated_at', now(),
    'subject_id',   p_user,
    'note', 'POPIA data-subject access export. Money in integer cents ex-VAT. '
         || 'Driver-usage logs are retained under a legal-obligation basis (AARTO); see docs/POPIA.md.',
    'profile', (select to_jsonb(u) from public.users u where u.id = p_user),
    'usage_logs', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_on desc), '[]'::jsonb)
      from usage_logs x where x.driver_user_id = p_user and x.deleted_at is null),
    'meter_readings', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from meter_readings x where x.by_user = p_user and x.deleted_at is null),
    'faults_reported', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from faults x where x.reported_by = p_user and x.deleted_at is null),
    'job_cards', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from job_cards x where (x.mechanic_user_id = p_user or x.approved_by = p_user) and x.deleted_at is null),
    'cost_entries_created', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from cost_entries x where x.created_by = p_user and x.deleted_at is null),
    'attachments_created', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from attachments x where x.created_by = p_user and x.deleted_at is null),
    'notifications', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from notifications x where x.user_id = p_user and x.deleted_at is null),
    'audit_actions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity', entity, 'entity_id', entity_id, 'action', action, 'at', at) order by at desc), '[]'::jsonb)
      from audit_log where user_id = p_user)
  ) into v_out;

  return v_out;
end $$;

revoke execute on function public.export_personal_data(uuid) from public, anon;
grant  execute on function public.export_personal_data(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- ERASURE (Right to deletion, done as anonymisation): clear a person's PII.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.erase_personal_data(p_user uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm         uuid;
  v_usage_scrub  bigint;
  v_fault_scrub  bigint;
begin
  if p_user = auth.uid() then
    raise exception 'you cannot erase your own account here';
  end if;
  v_farm := app.assert_can_manage_person(p_user, 'erasure');

  -- Anonymise the identity in-place + deactivate + soft-delete. The audit trigger on
  -- users records the change (proof of erasure); no directly-identifying value survives.
  update public.users set
    name            = '[erased]',
    email           = null,
    phone           = null,
    whatsapp_opt_in = false,
    active          = false,
    deleted_at      = coalesce(deleted_at, now()),
    deleted_by      = auth.uid()
  where id = p_user;

  -- Null the free-text name COPIES tied to this person (the id links remain, but the
  -- id now resolves to an anonymised profile).
  update usage_logs set driver_name = null
    where driver_user_id = p_user and driver_name is not null;
  get diagnostics v_usage_scrub = row_count;
  update faults set reporter_name = null
    where reported_by = p_user and reporter_name is not null;
  get diagnostics v_fault_scrub = row_count;

  -- Dedicated compliance-trail entry (over and above the users audit diff).
  insert into audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (v_farm, auth.uid(), 'data_subject_erasure', p_user, 'erasure',
          jsonb_build_object('by', auth.uid(), 'subject', p_user,
                             'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                             'usage_names_cleared', v_usage_scrub,
                             'fault_names_cleared', v_fault_scrub, 'at', now()));

  return jsonb_build_object(
    'erased', true, 'subject_id', p_user,
    'usage_names_cleared', v_usage_scrub, 'fault_names_cleared', v_fault_scrub,
    'note', 'Identity anonymised and account deactivated. Structural history (maintenance, '
         || 'finance, and legally-retained AARTO driver-usage records) is preserved de-identified.');
end $$;

revoke execute on function public.erase_personal_data(uuid, text) from public, anon;
grant  execute on function public.erase_personal_data(uuid, text) to authenticated;
