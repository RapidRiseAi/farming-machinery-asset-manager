-- 0383_draft_documents_are_private.sql
-- A partner's DRAFT is their working copy, not correspondence.
--
-- Found by driving the built app against the live demo project: signed in as the farm's
-- owner, TJ's unsent draft invoice (TJI-0002) appeared in the farmer's list alongside the
-- documents actually sent to them. 0381's SELECT policy scoped documents by FARM and by
-- ISSUING PARTNER, which is the tenancy question — but it never asked whether the
-- document had been sent, so a partner pricing a job could be watched doing it.
--
-- That is a product defect, not a cosmetic one: a partner who cannot draft privately will
-- draft somewhere else, and the number a farmer sees must be one the partner chose to
-- send. Fixing it in RLS rather than by hiding rows in the query keeps the rule true for
-- the PDF route, any future export, and anything else that reads the table.
--
-- Who still sees a draft: the issuing partner's staff, whoever created it (a farm
-- owner/manager recording a document they were handed on paper starts one too), and
-- rr_admin. Everything else about the policy is unchanged.

drop policy partner_documents_sel on partner_documents;

create policy partner_documents_sel on partner_documents for select to authenticated
  using (
    deleted_at is null
    and app.partner_doc_visible(farm_id, workshop_id)
    and (
      status <> 'draft'
      or workshop_id = app.user_workshop_id()
      or created_by = auth.uid()
      or app.is_rr_admin()
    )
  );

-- The child tables reach the same rule through app.partner_doc_visible_by_id, which
-- consults the parent row directly rather than through the policy — so restate the draft
-- rule there too, or a farmer would be denied the document but shown its line items.
create or replace function app.partner_doc_visible_by_id(p_doc uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.partner_documents d
     where d.id = p_doc
       and app.partner_doc_visible(d.farm_id, d.workshop_id)
       and (d.status <> 'draft'
            or d.workshop_id = app.user_workshop_id()
            or d.created_by = auth.uid()
            or app.is_rr_admin())
  );
$$;

revoke execute on function app.partner_doc_visible_by_id(uuid) from public, anon;
grant  execute on function app.partner_doc_visible_by_id(uuid) to authenticated, service_role;
