-- Operational commands lock a machine row so concurrent readings and fault capture stay
-- consistent. PostgreSQL applies UPDATE policies to SELECT ... FOR UPDATE/KEY SHARE, so
-- the administration-only update policy would otherwise make those commands invisible
-- to mechanics and operators. This policy exposes the row for locking, while its false
-- WITH CHECK still makes every direct machine UPDATE fail for those roles.

drop policy if exists machines_operational_lock on public.machines;
create policy machines_operational_lock on public.machines
  for update to authenticated
  using (
    app.effective_farm_role((select auth.uid()), farm_id) in ('mechanic','operator')
    and app.row_visible_to_role(farm_id, id)
  )
  with check (false);

