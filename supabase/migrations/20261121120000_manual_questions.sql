-- 20261121120000_manual_questions.sql
-- Task B5: questions over an asset's manuals (BRIEF "Manuals/document questions").
--
-- A manual is an asset document a business already stores (attachments, kind doc, on a machine).
-- Making it searchable reads its pages through the configured reader inside a hold on the
-- owner's spending limit (the app side: src/lib/manuals.ts) and stores the TEXT of each page here
-- with a full-text index. The file itself is not copied: no second storage charge, and the text it
-- adds is shown on the index row (text_bytes) rather than hidden. Search runs as the person
-- (security invoker): a page is found only when that person can see its document, so finance
-- documents and other businesses' files never come back. Deleting the document, or removing it from
-- search, deletes its pages. Off behind the readiness flag manual_questions, and Complete (and up)
-- only: it is paid from the same assistance limit as the rest of Complete's AI.
--
-- Additive: two tables, functions, a trigger and a flag.

insert into public.feature_flags (key, note, released) values
  ('manual_questions', 'Questions over asset manuals, answered with document and page citations. Off until a reader and its cost are approved.', false)
on conflict (key) do nothing;

-- One row per searchable document: what it is called, how big its text is, who made it searchable.
create table if not exists public.manual_index (
  attachment_id uuid primary key,
  farm_id       uuid not null references public.farms(id),
  machine_id    uuid not null,
  title         text not null check (char_length(btrim(title)) between 1 and 80 and title !~ '[<>[:cntrl:]]'),
  provider      text not null check (provider ~ '^[a-z0-9_-]{1,40}$'),
  pages         integer not null check (pages between 1 and 300),
  text_bytes    integer not null check (text_bytes >= 0),
  indexed_by    uuid references public.users(id),
  indexed_at    timestamptz not null default now(),
  foreign key (attachment_id, farm_id) references public.attachments(id, farm_id) on delete cascade,
  foreign key (machine_id, farm_id) references public.machines(id, farm_id)
);
create index if not exists manual_index_farm on public.manual_index (farm_id);

-- The text of each page, as read. Data only: searched and quoted, never followed.
create table if not exists public.manual_pages (
  id            uuid primary key default gen_random_uuid(),
  attachment_id uuid not null references public.manual_index(attachment_id) on delete cascade,
  farm_id       uuid not null references public.farms(id),
  page          integer not null check (page between 1 and 300),
  body          text not null check (char_length(body) <= 20000),
  -- 'simple': no English stemming or stop words, so Afrikaans and part numbers match as written.
  tsv           tsvector generated always as (to_tsvector('simple', body)) stored,
  unique (attachment_id, page)
);
create index if not exists manual_pages_tsv on public.manual_pages using gin (tsv);
create index if not exists manual_pages_farm on public.manual_pages (farm_id);

do $$ declare t text; begin
  foreach t in array array['manual_index', 'manual_pages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
-- The index row is audited; page text is not copied into the audit log (it is the document's own
-- words, already held as the file, and would multiply the log by the size of every manual).
drop trigger if exists manual_index_audit on public.manual_index;
create trigger manual_index_audit after insert or update or delete on public.manual_index
  for each row execute function public.app_audit();

-- A page is visible exactly when its document is: the attachments policies decide (finance
-- documents to those who may see finance, nothing across businesses), evaluated as the person.
drop policy if exists manual_index_sel on public.manual_index;
create policy manual_index_sel on public.manual_index for select to authenticated using (
  app.has_farm_access(farm_id)
  and exists (select 1 from public.attachments a where a.id = manual_index.attachment_id and a.farm_id = manual_index.farm_id and a.deleted_at is null)
);
drop policy if exists manual_pages_sel on public.manual_pages;
create policy manual_pages_sel on public.manual_pages for select to authenticated using (
  app.has_farm_access(farm_id)
  and exists (select 1 from public.attachments a where a.id = manual_pages.attachment_id and a.farm_id = manual_pages.farm_id and a.deleted_at is null)
);
select app.pay_gate_apply('manual_index');
select app.pay_gate_apply('manual_pages');

-- Is the feature on for this business: Complete's paid assistance (voice_ai rank) and the flag.
create or replace function app.manual_questions_on(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.farm_plan_allows(p_farm, 'voice_ai')
     and exists (select 1 from public.feature_flags f where f.key = 'manual_questions'
                  and (f.released or exists (select 1 from public.farm_feature_access a where a.farm_id = p_farm and a.key = f.key)));
$$;
revoke all on function app.manual_questions_on(uuid) from public, anon;
grant execute on function app.manual_questions_on(uuid) to authenticated, service_role;

-- For the app: may this person ask questions over manuals here (member, plan, flag).
create or replace function public.manual_questions_available(p_farm uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.has_farm_access(p_farm) then return false; end if;
  perform app.require_open_farm(p_farm, false);
  return app.manual_questions_on(p_farm);
exception when others then
  return false;
end $$;
revoke all on function public.manual_questions_available(uuid) from public, anon;
grant execute on function public.manual_questions_available(uuid) to authenticated;

-- == Writing the index (the service, after reading the pages under a spending hold) ==============
-- Replaces the document's pages. Only an asset's own document (kind doc, on a machine, not deleted),
-- only where the feature is on, only from the server that read it.
create or replace function public.manual_index_put(
  p_attachment uuid, p_title text, p_provider text, p_pages jsonb, p_by uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.attachments;
  v_page jsonb;
  v_no integer;
  v_body text;
  v_pages integer := 0;
  v_bytes integer := 0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into a from public.attachments where id = p_attachment for update;
  if not found or a.deleted_at is not null or a.parent_type <> 'machine' or a.kind <> 'doc' then
    raise exception 'manual-not-a-manual' using errcode = '22023';
  end if;
  perform app.require_open_farm(a.farm_id, true);
  if not app.manual_questions_on(a.farm_id) then raise exception 'manual-questions-off' using errcode = '42501'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 80 or p_title ~ '[<>[:cntrl:]]'
     or coalesce(p_provider, '') !~ '^[a-z0-9_-]{1,40}$'
     or p_pages is null or jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) not between 1 and 300 then
    raise exception 'manual-invalid' using errcode = '22023';
  end if;
  delete from public.manual_pages where attachment_id = a.id;
  insert into public.manual_index (attachment_id, farm_id, machine_id, title, provider, pages, text_bytes, indexed_by, indexed_at)
  values (a.id, a.farm_id, a.parent_id, btrim(p_title), p_provider, 1, 0, p_by, now())
  on conflict (attachment_id) do update set title = excluded.title, provider = excluded.provider,
    indexed_by = excluded.indexed_by, indexed_at = now();
  for v_page in select value from jsonb_array_elements(p_pages) loop
    if jsonb_typeof(v_page) <> 'object' or coalesce(v_page ->> 'page', '') !~ '^[0-9]{1,3}$' then
      raise exception 'manual-invalid' using errcode = '22023';
    end if;
    v_no := (v_page ->> 'page')::integer;
    -- Control characters out; text kept as words, at most 20 000 characters a page.
    v_body := left(btrim(regexp_replace(coalesce(v_page ->> 'text', ''), '[[:cntrl:]]+', ' ', 'g')), 20000);
    if v_no not between 1 and 300 then raise exception 'manual-invalid' using errcode = '22023'; end if;
    if v_body = '' then continue; end if;
    insert into public.manual_pages (attachment_id, farm_id, page, body) values (a.id, a.farm_id, v_no, v_body)
    on conflict (attachment_id, page) do nothing;
    if found then v_pages := v_pages + 1; v_bytes := v_bytes + octet_length(v_body); end if;
  end loop;
  if v_pages = 0 then raise exception 'manual-empty' using errcode = '22023'; end if;
  update public.manual_index set pages = v_pages, text_bytes = v_bytes where attachment_id = a.id;
  return jsonb_build_object('pages', v_pages, 'text_bytes', v_bytes);
end $$;
revoke all on function public.manual_index_put(uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.manual_index_put(uuid, text, text, jsonb, uuid) to service_role;

-- Taking a document out of search (owner, manager, Rapid Rise in support). Its pages go with it.
create or replace function public.manual_index_remove(p_attachment uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_farm uuid;
begin
  select farm_id into v_farm from public.manual_index where attachment_id = p_attachment;
  if not found then return false; end if;
  if not (app.has_farm_access(v_farm)
          and coalesce(app.effective_farm_role((select auth.uid()), v_farm)::text, '') in ('rr_admin', 'owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(v_farm, true);
  delete from public.manual_index where attachment_id = p_attachment;
  return true;
end $$;
revoke all on function public.manual_index_remove(uuid) from public, anon;
grant execute on function public.manual_index_remove(uuid) to authenticated;

-- Deleting the document deletes its searchable text: a soft delete (deleted_at set) as well as a
-- hard one (the foreign keys cascade).
create or replace function app.manual_index_follow_attachment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from public.manual_index where attachment_id = new.id;
  end if;
  return new;
end $$;
revoke all on function app.manual_index_follow_attachment() from public, anon;
drop trigger if exists attachments_manual_index on public.attachments;
create trigger attachments_manual_index after update of deleted_at on public.attachments
  for each row execute function app.manual_index_follow_attachment();

-- == Searching (as the person) ====================================================================
-- Up to eight distinct words of two or more letters or digits, any of them matching, best pages
-- first. Runs as the caller, so the policies above decide which pages exist for them. Returns no
-- rows when nothing matches: the assistant then says there is no supporting evidence.
create or replace function public.manual_search(p_farm uuid, p_query text, p_machine uuid default null, p_limit integer default 5)
returns table (attachment_id uuid, machine_id uuid, title text, page integer, excerpt text, rank real)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_query tsquery;
  v_terms text;
begin
  if not app.has_farm_access(p_farm) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not app.manual_questions_on(p_farm) then raise exception 'manual-questions-off' using errcode = '42501'; end if;
  if p_query is null or char_length(p_query) > 300 then raise exception 'manual-invalid' using errcode = '22023'; end if;
  -- Question words and fillers in English and Afrikaans carry no meaning for a manual and would let a
  -- page full of "the" and "is" outrank the page that answers.
  select string_agg(w, ' | ') into v_terms from (
    select distinct w from regexp_split_to_table(lower(p_query), '[^[:alnum:]]+') w
     where char_length(w) between 2 and 40
       and w <> all (array['the', 'is', 'are', 'was', 'what', 'which', 'how', 'much', 'many', 'does', 'do', 'did', 'of',
                           'to', 'for', 'in', 'on', 'at', 'an', 'and', 'or', 'it', 'its', 'my', 'our', 'me', 'can', 'should',
                           'with', 'by', 'be', 'this', 'that', 'there', 'when', 'where', 'who', 'why', 'please', 'tell',
                           'die', 'wat', 'hoe', 'hoeveel', 'van', 'vir', 'op', 'en', 'of', 'dit', 'ons', 'is', 'het', 'moet',
                           'kan', 'met', 'by', 'wanneer', 'waar', 'wie', 'hoekom', 'asseblief', 'sê', 'se'])
     limit 8
  ) words;
  if v_terms is null then return; end if;
  v_query := to_tsquery('simple', v_terms);
  return query
    select p.attachment_id, i.machine_id, i.title, p.page,
           ts_headline('simple', p.body, v_query, 'MaxFragments=2, MaxWords=40, MinWords=12, StartSel="", StopSel="", FragmentDelimiter=" ... "'),
           ts_rank_cd(p.tsv, v_query)
      from public.manual_pages p
      join public.manual_index i on i.attachment_id = p.attachment_id
     where p.farm_id = p_farm and p.tsv @@ v_query
       and (p_machine is null or i.machine_id = p_machine)
     order by ts_rank_cd(p.tsv, v_query) desc, p.attachment_id, p.page
     limit least(greatest(coalesce(p_limit, 5), 1), 8);
end $$;
revoke all on function public.manual_search(uuid, text, uuid, integer) from public, anon;
grant execute on function public.manual_search(uuid, text, uuid, integer) to authenticated;

-- Which manuals were made searchable, by whom: the business's own history (page text is not audited).
insert into app.audit_table_rules (table_name, scope, reason) values
  ('manual_index', 'farm', 'a business''s searchable manuals and who made them searchable')
on conflict (table_name) do nothing;
