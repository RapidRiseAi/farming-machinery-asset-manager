-- 0401_vat_registration.sql
-- Not every partner charges VAT.
--
-- The document model assumed VAT always applies: every quote and invoice carried a rate,
-- showed a VAT line, and split the total. For a partner below the SARS registration
-- threshold — which is most one-van operations — that is not a formatting preference,
-- it is a document claiming to charge a tax they are not registered for.
--
-- `vat_registered` makes it a property of the business. When false, documents show no
-- VAT line, the total equals the net, and the totals triggers compute a zero VAT
-- component rather than a hidden one. The RATE stays editable either way, because a rate
-- that is right today is a rate that changed before and will change again — SA went
-- 14% → 15% in 2018, and the 2025 attempt to reach 15.5% got as far as being gazetted
-- before it was withdrawn. A system that hardcodes it is a system that breaks on budget
-- day.
--
-- Existing partners are marked registered, which is what they have been behaving as, so
-- nothing already issued changes meaning.

alter table workshops
  add column vat_registered boolean not null default true;

comment on column workshops.vat_registered is
  'Does this partner charge VAT? When false their documents show no VAT line and the '
  'total equals the net. The rate stays editable either way — it has changed before.';

-- A partner who is not VAT registered issues documents at a zero rate. Enforced here as
-- well as in the app so a stale form, an API call or an import cannot produce a document
-- that charges VAT the issuer cannot legally collect.
create or replace function app_partner_document_vat_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from workshops w where w.id = new.workshop_id and w.vat_registered
  ) then
    new.vat_rate_bps := 0;
  end if;
  return new;
end $$;

create trigger partner_documents_vat_guard
  before insert or update of vat_rate_bps, workshop_id on partner_documents
  for each row execute function app_partner_document_vat_guard();

revoke execute on function app_partner_document_vat_guard() from anon, authenticated, public;
