-- 0434_document_layout.sql
-- How a partner's documents are LAID OUT, not just what colour they are.
--
-- ── What this is, and deliberately is not ────────────────────────────────────
--
-- It is not a drag-and-drop designer. A partner does not want to design a document; they
-- want theirs to look like the one they have been sending for fifteen years, and the
-- handful of differences that actually matter are the same handful every time:
--
--   * which blocks appear at all (their VAT number, the vehicle, banking, a signature
--     line, a "thank you" — a workshop that never quotes on vehicles should not have an
--     empty vehicle row on every document);
--   * what the blocks are CALLED. "Quote" or "Estimate" or "Quotation"; "Invoice" or "Tax
--     Invoice" — and that last one is not cosmetic, because a VAT-registered vendor's
--     document must be headed "tax invoice" to be one (VAT Act s20(4));
--   * how dense it is, and whether the accent colour is a band or a hairline.
--
-- So: a small, closed set of choices, stored as jsonb on the workshop and applied
-- identically by the screen and the PDF. Closed rather than free-form because every value
-- here has to be understood by two renderers — anything they cannot both honour would be
-- a promise the PDF quietly breaks.
--
-- ── Why it goes on the workshop, and gets frozen ─────────────────────────────
--
-- `workshops` already IS the partner account, so the layout inherits its RLS, its audit
-- trigger and the `workshops_upd_self` policy (0380) that lets a partner maintain their
-- own letterhead. And like the letterhead, the chosen layout is snapshotted onto a
-- document when it is issued — `issuer_snapshot` already carries the branding, and this
-- rides in the same object. A partner who redesigns their documents next year must not
-- restate last year's invoice.

alter table workshops
  add column doc_layout jsonb not null default '{}'::jsonb;

comment on column workshops.doc_layout is
  'How this partner''s documents are laid out (G9): which blocks show, what they are '
  'called, density and accent style. A closed set of keys, applied identically by the '
  'screen and the PDF, and frozen into issuer_snapshot when a document is issued.';

-- A guard rather than a schema: jsonb is the right storage for a handful of optional
-- display flags, but "anything at all" is not. This refuses keys neither renderer knows
-- about, so a typo fails at the point it is made rather than silently doing nothing.
create or replace function app_workshops_check_layout() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare k text;
begin
  if new.doc_layout is null then
    new.doc_layout := '{}'::jsonb;
    return new;
  end if;

  if jsonb_typeof(new.doc_layout) <> 'object' then
    raise exception 'The document layout must be a set of settings.' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(new.doc_layout) loop
    if k not in (
      -- What things are called
      'quote_title', 'invoice_title', 'credit_title', 'debit_title',
      'bill_to_label', 'items_label', 'total_label',
      -- Which blocks appear
      'show_vehicle', 'show_vat_number', 'show_banking', 'show_signature',
      'show_line_numbers', 'show_unit_price', 'show_thanks', 'thanks_text',
      -- How it looks
      'density', 'accent_style'
    ) then
      raise exception 'Unknown document layout setting: %', k using errcode = '22023';
    end if;
  end loop;

  if new.doc_layout ? 'density'
     and new.doc_layout->>'density' not in ('comfortable', 'compact') then
    raise exception 'Density must be comfortable or compact.' using errcode = '22023';
  end if;
  if new.doc_layout ? 'accent_style'
     and new.doc_layout->>'accent_style' not in ('band', 'line', 'plain') then
    raise exception 'Accent style must be band, line or plain.' using errcode = '22023';
  end if;

  return new;
end $$;

create trigger workshops_check_layout
  before insert or update of doc_layout on workshops
  for each row execute function app_workshops_check_layout();

-- ── Setting it ───────────────────────────────────────────────────────────────
-- A merge rather than a replace, so a screen that offers three settings cannot wipe the
-- other twelve — the same jsonb `||` discipline `update_farm_settings` (0204) uses.
create or replace function public.update_document_layout(p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_workshop uuid; v_out jsonb;
begin
  v_workshop := app.user_workshop_id();
  if v_workshop is null then
    raise exception 'Only a partner business can change its own document layout.' using errcode = '42501';
  end if;

  update workshops
     set doc_layout = coalesce(doc_layout, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)
   where id = v_workshop
   returning doc_layout into v_out;

  return v_out;
end $$;

revoke execute on function public.update_document_layout(jsonb) from public, anon;
grant  execute on function public.update_document_layout(jsonb) to authenticated, service_role;

comment on function public.update_document_layout(jsonb) is
  'Merge document-layout settings for the CALLER''s own workshop. The workshop is taken '
  'from the session, never from an argument, so a partner cannot restyle another '
  'partner''s documents.';
