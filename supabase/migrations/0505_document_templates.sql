-- 0505_document_templates.sql
-- Which of the four document TEMPLATES this partner picked.
--
-- ── Why a template on top of 0434 ────────────────────────────────────────────
--
-- 0434 gave a partner sixteen switches over how their documents look, and settled why it
-- is a closed set rather than a designer. It was right, and almost nobody will open it:
-- sixteen switches is still a design job, and a workshop that wants "the plain one that
-- photocopies" should not have to work out that this means no accent, roomy rows and a
-- signature line.
--
-- So this migration adds the CHOICE, not another layout system. A template is a named set
-- of 0434 keys; applying one goes through 0434's own `update_document_layout` merge, is
-- resolved by 0434's own resolver, and is therefore honoured identically by the screen and
-- the PDF. Nothing new can be expressed, which is exactly the property that keeps the two
-- renderers in step.
--
-- ── Nothing existing may change appearance ───────────────────────────────────
--
-- The default is `classic`, and `classic` is DEFINED as the layout every partner already
-- had: `{density: comfortable, accent_style: band, vehicle/VAT/banking on, signature and
-- line numbers off, unit price on}` — key for key what `resolveLayout({})` returns. So
-- this column lands on every existing workshop naming a template that changes nothing,
-- and no document — sent, drafted or yet to be raised — looks different tomorrow.
--
-- ── What the database knows, and what it does not ────────────────────────────
--
-- It knows the closed set of NAMES, guarded exactly as 0434 guards layout keys: a typo
-- fails at the point it is made rather than silently storing a template nobody will ever
-- render. It does NOT know what each name means. Both renderers are TypeScript, so the
-- name → keys map lives in `src/lib/doc-templates.ts` as the single source of truth; a SQL
-- mirror would be a second copy with nothing keeping it honest (the same reasoning 0492
-- recorded for the partner plan). `doc_template` is therefore a RECORD OF THE CHOICE, and
-- `doc_layout` remains the only thing that renders.

alter table workshops
  add column doc_template text not null default 'classic';

comment on column workshops.doc_template is
  'Which named document template this partner chose (0505). A record of the choice, not '
  'an authority: what renders is doc_layout, which the template sets through '
  'update_document_layout. Defaults to ''classic'', the preset defined as the layout '
  'every partner already had, so adding this column changes no document''s appearance.';

-- ── The guard ────────────────────────────────────────────────────────────────
-- The 0434 pattern: a closed set, refused loudly. A partner who somehow posts
-- 'moderne-luxe' has not chosen a template — they have stored a word that no renderer will
-- ever recognise, and would go on believing their documents had changed.
create or replace function app_workshops_check_template() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The column is `not null default`, so this is belt and braces rather than a real path.
  if new.doc_template is null then
    new.doc_template := 'classic';
    return new;
  end if;

  if new.doc_template not in ('classic', 'compact', 'plain', 'totals_only') then
    raise exception 'Unknown document template: %', new.doc_template using errcode = '22023';
  end if;

  return new;
end $$;

create trigger workshops_check_template
  before insert or update of doc_template on workshops
  for each row execute function app_workshops_check_template();

-- A trigger function is reached by the trigger, never called; the EXECUTE privilege is
-- checked when the trigger is created, not when it fires. Revoked for the same reason
-- 0380 revokes `app_workshop_guard_plan`.
revoke execute on function app_workshops_check_template() from anon, authenticated, public;

-- ── Applying one ─────────────────────────────────────────────────────────────
-- ONE write path for the layout. This does not repeat 0434's `||` merge — it CALLS
-- `update_document_layout`, so there is still exactly one statement in the schema that
-- writes `doc_layout`, and a setting added to that function later is inherited here for
-- free.
--
-- The workshop comes from the SESSION, never from an argument, so there is no id to tamper
-- with and a partner cannot restyle a competitor's documents. The name is stamped FIRST so
-- an unrecognised one fails before any layout moves; either way both statements share the
-- transaction, so a refused name applies nothing at all.
--
-- `p_layout` is trusted to be the template's own key set because the map lives app-side
-- (see the header). The worst a hand-rolled call can do is desync a partner's OWN stored
-- label from their OWN layout, which mislabels one card on their own settings screen and
-- reaches nobody else's documents. Validating the pair here would mean mirroring the map
-- into SQL, which is the thing this migration is avoiding.
--
-- SECURITY INVOKER, deliberately, where 0434's `update_document_layout` is DEFINER. The
-- `where id = app.user_workshop_id()` clause below is a check somebody could one day
-- rewrite; `workshops_upd_self` (0380) is not. Running as the caller means BOTH have to
-- fail before a partner reaches another partner's row, which is the reasoning G14 recorded
-- for the money functions. The nested call to `update_document_layout` still runs as its
-- own definer, so the layout merge itself is unchanged.
create or replace function public.apply_document_template(p_template text, p_layout jsonb)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_workshop uuid; v_out jsonb;
begin
  v_workshop := app.user_workshop_id();
  if v_workshop is null then
    raise exception 'Only a partner business can choose its own document template.'
      using errcode = '42501';
  end if;

  update workshops set doc_template = p_template where id = v_workshop;

  v_out := public.update_document_layout(coalesce(p_layout, '{}'::jsonb));

  return v_out;
end $$;

revoke execute on function public.apply_document_template(text, jsonb) from public, anon;
grant  execute on function public.apply_document_template(text, jsonb) to authenticated, service_role;

comment on function public.apply_document_template(text, jsonb) is
  'Record the CALLER''s own choice of document template and apply its layout keys, in one '
  'transaction. The workshop is taken from the session, never from an argument. The layout '
  'is merged through update_document_layout so there is one write path for doc_layout, not '
  'two.';
