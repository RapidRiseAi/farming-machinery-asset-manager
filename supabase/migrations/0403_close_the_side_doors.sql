-- 0403_close_the_side_doors.sql
-- Five ways round the F16 access scope, found by review of 0400–0402. All real.
--
-- The lesson in all of them is the same: narrowing the tables a contractor can read is
-- not the same as narrowing what they can REACH. Storage has its own policies. A
-- notification carries a copy of the thing it is about. A trigger that fires on one
-- column does not fire on the update that matters. Each of these was a door left open
-- beside the one that was just locked.

-- ── 1. NOTIFICATIONS CARRIED THE PAYLOAD PAST EVERY GATE ─────────────────────
--
-- `notifications_sel` (0101) is `app.has_farm_access(farm_id)`, so a linked contractor
-- could read every notification row on the farm — and the payloads carry exactly what
-- 0400 had just gated: quote and invoice totals, fault descriptions, fuel anomalies,
-- whole-farm weekly digests. Gating the source tables while leaving the notifications
-- that quote them is not a gate.
--
-- The correct rule is narrower than farm access for EVERYONE, not just contractors: a
-- notification is addressed to a person (`app.notify_farm` inserts one row per
-- recipient), so the person it is addressed to is who should read it. That is what the
-- alert centre and the inbox already query.
drop policy notifications_sel on notifications;
create policy notifications_sel on notifications for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or user_id = auth.uid()));

-- ── 2. STORAGE WAS NOT NARROWED AT ALL ───────────────────────────────────────
--
-- 0382's object policies are farm-scoped only, so a linked contractor could list and
-- download every file under that farm: other contractors' invoice PDFs out of
-- `partner-docs`, photos of vehicles they have nothing to do with, fault voice notes.
-- The UI said those contractors were never visible; the Storage API disagreed.
--
-- One helper resolves an object key to a visibility decision, so the four object
-- policies stay one line each and cannot drift apart. Paths are `{farm_id}/{parent}/…`
-- throughout, which is what makes this expressible at all.
create or replace function app.storage_object_visible(p_bucket text, p_name text)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_farm   uuid;
  v_parent uuid;
begin
  begin
    v_farm := nullif((storage.foldername(p_name))[1], '')::uuid;
    v_parent := nullif((storage.foldername(p_name))[2], '')::uuid;
  exception when others then
    return false;                        -- a key we do not recognise is not readable
  end;

  if v_farm is null or not app.has_farm_access(v_farm) then
    return false;
  end if;

  -- Farm side and rr_admin: unchanged, farm access is the whole rule.
  if app.is_rr_admin() or app.current_app_role() is distinct from 'workshop' then
    return true;
  end if;

  -- A contractor reaches only the files attached to something they can already see.
  if p_bucket = 'partner-docs' then
    return app.partner_doc_visible_by_id(v_parent);
  elsif p_bucket in ('machine-photos', 'machine-docs') then
    return app.partner_machine_visible(v_farm, v_parent);
  elsif p_bucket in ('fault-photos', 'fault-voice') then
    return exists (select 1 from public.faults f
                   where f.id = v_parent and app.partner_machine_visible(f.farm_id, f.machine_id));
  elsif p_bucket = 'jobcard-photos' then
    -- Used by job cards AND work requests; both resolve to a machine.
    return exists (select 1 from public.job_cards jc
                   where jc.id = v_parent and app.partner_machine_visible(jc.farm_id, jc.machine_id))
        or exists (select 1 from public.work_requests wr
                   where wr.id = v_parent and app.partner_machine_visible(wr.farm_id, wr.machine_id));
  elsif p_bucket = 'checklist-photos' then
    return exists (select 1 from public.checklist_instances ci
                   where ci.id = v_parent and app.partner_machine_visible(ci.farm_id, ci.machine_id));
  end if;

  return false;
end $$;

revoke execute on function app.storage_object_visible(text, text) from public, anon;
grant  execute on function app.storage_object_visible(text, text) to authenticated, service_role;

do $do$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;                              -- local test Postgres has no storage schema
  end if;

  execute 'drop policy if exists "farmgear objects read"   on storage.objects';
  execute 'drop policy if exists "farmgear objects insert" on storage.objects';
  execute 'drop policy if exists "farmgear objects update" on storage.objects';
  execute 'drop policy if exists "farmgear objects delete" on storage.objects';

  execute $p$
    create policy "farmgear objects read" on storage.objects for select to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.storage_object_visible(bucket_id, name))
  $p$;
  execute $p$
    create policy "farmgear objects insert" on storage.objects for insert to authenticated
    with check (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.storage_object_visible(bucket_id, name))
  $p$;
  execute $p$
    create policy "farmgear objects update" on storage.objects for update to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.storage_object_visible(bucket_id, name))
  $p$;
  execute $p$
    create policy "farmgear objects delete" on storage.objects for delete to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos','partner-docs')
           and app.storage_object_visible(bucket_id, name))
  $p$;
end $do$;

-- ── 3 + 4. THE VAT GUARD FIRED TOO LATE AND DID TOO LITTLE ───────────────────
--
-- Two faults in 0401, both real:
--
--   * It fired only when `vat_rate_bps` or `workshop_id` was in the UPDATE. Sending a
--     draft touches `status`, `sent_at` and the snapshots — so a draft priced at 15%
--     while the partner was registered went out at 15% after they deregistered.
--
--   * Trigger order is alphabetical within the same timing, and
--     `partner_documents_self_totals` sorts before `partner_documents_vat_guard`. So the
--     totals were computed WITH VAT and only the rate was then zeroed, leaving a row that
--     shows no VAT line while still charging it. An `uploaded` document is worse: its
--     totals are authoritative and typed, so a nonzero `vat_cents` simply survived.
--
-- Fixed by firing on every insert/update and normalising the money as well as the rate.
-- The name is chosen to sort AFTER the totals trigger deliberately — it is the last word
-- on this row, and it needs the totals to already be there so it can correct them.
drop trigger partner_documents_vat_guard on partner_documents;
drop function app_partner_document_vat_guard();

create or replace function app_partner_document_zz_vat_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_net bigint;
begin
  if exists (select 1 from workshops w where w.id = new.workshop_id and w.vat_registered) then
    return new;                          -- registered: nothing to correct
  end if;

  -- Not registered: no rate, no VAT component, and the total is the net. This runs after
  -- the totals triggers precisely so it can overwrite whatever they computed.
  v_net := greatest(0, coalesce(new.subtotal_cents, 0)
                     - least(coalesce(new.discount_cents, 0), coalesce(new.subtotal_cents, 0)));
  new.vat_rate_bps := 0;
  new.vat_cents    := 0;
  new.total_cents  := v_net;
  return new;
end $$;

create trigger partner_documents_zz_vat_guard
  before insert or update on partner_documents
  for each row execute function app_partner_document_zz_vat_guard();

revoke execute on function app_partner_document_zz_vat_guard() from anon, authenticated, public;

-- ── 5. A SECOND SITE'S OWNER COULD NOT ACTUALLY CHANGE ANYTHING ──────────────
--
-- `wl_upd` (0101) allows an update only when `app.user_farm_id() = farm_id` — the
-- PRIMARY farm. Since F7 an owner can be looking at a second site through
-- `user_farm_memberships`, and the F16 access card and the disconnect button both write
-- against the farm being viewed. On a secondary farm that update matched zero rows,
-- returned no error, and redirected saying it had worked — so an owner could be told a
-- contractor was disconnected while their access carried on.
--
-- Widened to the farms the user actually reaches, restricted to the roles that may make
-- this decision. Workshops are still excluded (they hold no farm role), so a partner
-- still cannot approve or re-scope itself.
drop policy wl_upd on workshop_links;
create policy wl_upd on workshop_links for update to authenticated
  using (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner', 'manager'))
  )
  with check (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner', 'manager'))
  );
