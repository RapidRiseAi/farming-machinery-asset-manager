-- The activity log must never show a reader more than the source table would (follow-up):
-- the cross-farm data-subject guard still sees a person's refiled history.
--
-- app.assert_local_person_scope (20260820165542) stops a farm's owner or manager from
-- exporting or erasing a person who has a trace on ANOTHER farm; its last, catch-all test is
-- "any audit row by this person filed under a different farm". Since 20261028091500 rows of
-- tables narrower than a farm's log (billing, notifications, memberships, driving, the
-- contractor's books) are filed with farm_id null and the farm in about_farm_id, so that test
-- no longer saw them: a person whose only trace elsewhere was such a row would pass the
-- guard. This puts the farm back in the comparison: farm_id, or else about_farm_id.
--
-- The test moves into a helper, app.person_audit_elsewhere(), so a later rewrite of the guard
-- can call it instead of repeating it. The guard is rewritten in place from the live
-- definition (the way 20261026090000 does), so nothing else in it can drift; it stops if the
-- text it expects is not there, and returns early if already applied.

create or replace function app.person_audit_elsewhere(p_user uuid, p_primary_farm uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.audit_log x
     where x.user_id = p_user
       and coalesce(x.farm_id, x.about_farm_id) <> p_primary_farm
  );
$$;

comment on function app.person_audit_elsewhere(uuid, uuid) is
  'True when the person has an audit row about a farm other than the given one, whether filed '
  'under it (farm_id) or for Rapid Rise about it (about_farm_id). 20261028093000.';

revoke all on function app.person_audit_elsewhere(uuid, uuid)
  from public, anon, authenticated, service_role;

do $migration$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('app.assert_local_person_scope(uuid,uuid)'::regprocedure);
  if position('app.person_audit_elsewhere(' in v_def) > 0 then
    return; -- already applied
  end if;
  v_new := regexp_replace(
    v_def,
    'exists \(\s*select 1 from public\.audit_log x\s+where x\.user_id = p_user and x\.farm_id <> p_primary_farm\s*\)',
    'app.person_audit_elsewhere(p_user, p_primary_farm)'
  );
  if v_new = v_def or position('app.person_audit_elsewhere(' in v_new) = 0 then
    raise exception 'assert_local_person_scope: the audit_log test was not where expected; not changed';
  end if;
  execute v_new;
end
$migration$;

-- create or replace keeps the grants, but say it again: nobody but the definer RPCs calls it.
revoke all on function app.assert_local_person_scope(uuid, uuid)
  from public, anon, authenticated, service_role;
