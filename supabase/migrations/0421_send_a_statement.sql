-- 0421_send_a_statement.sql
-- A statement you cannot send is half a feature.
--
-- G2c built the statement — opening balance, every movement, ageing, PDF and CSV — and
-- G2 built email for DOCUMENTS. But the customer this whole screen exists for is the one
-- who never looks at an individual invoice and pays off a statement once a month, and
-- there was no way to actually send them one. They could be emailed six invoices and no
-- statement, which is the opposite of what they asked for.
--
-- `document_emails` already answers "did it go, and where" for documents, and the answer
-- for a statement is the same question. So it widens rather than growing a second table
-- that would drift: `document_id` becomes nullable, the recipient and period come along,
-- and the read policy learns the second shape.

alter table document_emails
  alter column document_id drop not null,
  add column partner_client_id uuid references partner_clients(id),
  add column period_from date,
  add column period_to   date;

comment on column document_emails.document_id is
  'The document that was emailed, or null when this was a STATEMENT — in which case the '
  'recipient is farm_id / partner_client_id and the window is period_from..period_to.';

-- A statement row must know who it went to and for when; a document row must not pretend
-- to be one.
alter table document_emails
  add constraint document_emails_subject_ck check (
    (document_id is not null and period_from is null and period_to is null)
    or (document_id is null and period_from is not null and period_to is not null
        and (farm_id is not null or partner_client_id is not null))
  );

create index document_emails_statement_idx on document_emails(workshop_id, period_to desc)
  where document_id is null;

-- ── Who may read the record of a send ────────────────────────────────────────
-- Documents: unchanged, follows the document. Statements: the partner who sent it, and
-- the farm it was sent to — a client-book customer has no login, so only the partner.
drop policy document_emails_sel on document_emails;
create policy document_emails_sel on document_emails for select to authenticated
  using (
    deleted_at is null
    and case
      when document_id is not null then app.partner_doc_visible_by_id(document_id)
      else app.is_rr_admin()
        or workshop_id = app.user_workshop_id()
        or (farm_id is not null and app.has_farm_access(farm_id)
            and app.current_app_role() is distinct from 'operator')
    end
  );
