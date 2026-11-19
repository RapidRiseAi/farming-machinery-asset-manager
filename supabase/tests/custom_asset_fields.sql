-- Custom asset fields (B5, 20261121100000): plan, roles, typed values, markup refused, visibility,
-- rename and retire without losing values, isolation between businesses, equipment, audit.
-- Scenario 44 (custom field isolation and validation).
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'CUSTOM FIELDS FAIL: %', why; end if; end $$;
create function pg_temp.raises(p_sql text, p_like text) returns boolean language plpgsql as $$
begin execute p_sql; return false; exception when others then return sqlerrm like p_like; end $$;
create function pg_temp.login(u text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true)
$$;

insert into public.farms(id,name,plan,status) values
 ('cf000000-0000-4000-9000-000000000001','Pro farm','professional','active'),
 ('cf000000-0000-4000-9000-000000000002','Essential farm','essential','active'),
 ('cf000000-0000-4000-9000-000000000003','Other pro farm','professional','active');
insert into auth.users(id,email) select ('cf100000-0000-4000-9000-00000000000'||n)::uuid,'cf'||n||'@example.test' from generate_series(1,5) n;
insert into public.users(id,farm_id,role,name,email,active) values
 ('cf100000-0000-4000-9000-000000000001','cf000000-0000-4000-9000-000000000001','owner','Pro owner','cf1@example.test',true),
 ('cf100000-0000-4000-9000-000000000002','cf000000-0000-4000-9000-000000000001','manager','Pro manager','cf2@example.test',true),
 ('cf100000-0000-4000-9000-000000000003','cf000000-0000-4000-9000-000000000001','operator','Pro operator','cf3@example.test',true),
 ('cf100000-0000-4000-9000-000000000004','cf000000-0000-4000-9000-000000000002','owner','Essential owner','cf4@example.test',true),
 ('cf100000-0000-4000-9000-000000000005','cf000000-0000-4000-9000-000000000003','owner','Other owner','cf5@example.test',true);
insert into public.machines(id,farm_id,name,type) values
 ('cf200000-0000-4000-9000-000000000001','cf000000-0000-4000-9000-000000000001','Tractor','tractor'),
 ('cf200000-0000-4000-9000-000000000002','cf000000-0000-4000-9000-000000000002','Essential tractor','tractor'),
 ('cf200000-0000-4000-9000-000000000003','cf000000-0000-4000-9000-000000000003','Other tractor','tractor');

-- == [1] The plan: Essential keeps its standard fields only ===================================
select pg_temp.login('cf100000-0000-4000-9000-000000000004'); set local role authenticated;
select pg_temp.assert(pg_temp.raises($q$select public.asset_field_define('cf000000-0000-4000-9000-000000000002','Colour','text')$q$, '%plan-feature-custom_fields%'),
  '[1] Essential cannot define custom fields');
reset role;

-- == [2] Defining: owner and manager only, typed, markup refused ==============================
select pg_temp.login('cf100000-0000-4000-9000-000000000001'); set local role authenticated;
create temp table ids(name text primary key, id uuid) on commit drop;
grant all on ids to authenticated;
insert into ids values ('colour', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Colour','text'));
insert into ids values ('tank', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Tank size','number','L'));
insert into ids values ('bought', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Bought on','date'));
insert into ids values ('insured', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Insured','yes_no'));
insert into ids values ('site', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Yard','choice',null,array['North','South'],true));
insert into ids values ('secret', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Purchase ref','text',null,'{}',false,'managers','Finance'));
select pg_temp.assert((select key from public.asset_field_definitions where id=(select id from ids where name='tank'))='tank_size',
  '[2] the key comes from the label, chosen by the server');
select pg_temp.assert(pg_temp.raises($q$select public.asset_field_define('cf000000-0000-4000-9000-000000000001','<script>alert(1)</script>','text')$q$, '%custom-field-invalid%'),
  '[2] markup in a label is refused');
insert into ids values ('inject', public.asset_field_define('cf000000-0000-4000-9000-000000000001','Ok','text',null,'{}',false,'everyone','x''); drop table public.machines; --'));
select pg_temp.assert((select group_label from public.asset_field_definitions where id=(select id from ids where name='inject'))='x''); drop table public.machines; --'
  and to_regclass('public.machines') is not null, '[2] an injection attempt is stored as words, never run');
select pg_temp.assert(pg_temp.raises($q$select public.asset_field_define('cf000000-0000-4000-9000-000000000001','Size','blob')$q$, '%custom-field-invalid%'),
  '[2] an unknown type is refused');
reset role;
select pg_temp.login('cf100000-0000-4000-9000-000000000003'); set local role authenticated;
select pg_temp.assert(pg_temp.raises($q$select public.asset_field_define('cf000000-0000-4000-9000-000000000001','Mine','text')$q$, '%forbidden%'),
  '[2] an operator cannot define a field');
reset role;

-- == [3] Values: typed, validated, cleared, isolated =========================================
select pg_temp.login('cf100000-0000-4000-9000-000000000002'); set local role authenticated;
select public.asset_field_set('cf200000-0000-4000-9000-000000000001', jsonb_build_object(
  (select id from ids where name='colour')::text, 'Green <b>bold</b>',
  (select id from ids where name='tank')::text, 350.5,
  (select id from ids where name='bought')::text, '2024-03-01',
  (select id from ids where name='insured')::text, true,
  (select id from ids where name='site')::text, 'North'));
select pg_temp.assert((select value_number from public.asset_field_values where definition_id=(select id from ids where name='tank'))=350.5,
  '[3] a number is kept as a number');
select pg_temp.assert((select value_text from public.asset_field_values where definition_id=(select id from ids where name='colour'))='Green <b>bold</b>',
  '[3] text is kept as data, exactly as typed (the screen escapes it)');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "lots"}')$q$, (select id from ids where name='tank')), '%custom-field-invalid%'),
  '[3] words in a number field are refused');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "2024-02-30"}')$q$, (select id from ids where name='bought')), '%custom-field-invalid%'),
  '[3] an impossible date is refused');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "East"}')$q$, (select id from ids where name='site')), '%custom-field-invalid%'),
  '[3] a choice that is not on the list is refused');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "yes"}')$q$, (select id from ids where name='insured')), '%custom-field-invalid%'),
  '[3] yes/no takes true or false only');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": null}')$q$, (select id from ids where name='site')), '%custom-field-required%'),
  '[3] a required field cannot be cleared');
select public.asset_field_set('cf200000-0000-4000-9000-000000000001', jsonb_build_object((select id from ids where name='insured')::text, null));
select pg_temp.assert(not exists (select 1 from public.asset_field_values where definition_id=(select id from ids where name='insured')),
  '[3] an optional value is cleared');
reset role;

-- == [4] Visibility: a managers field is hidden from an operator ===============================
select pg_temp.login('cf100000-0000-4000-9000-000000000001'); set local role authenticated;
select public.asset_field_set('cf200000-0000-4000-9000-000000000001', jsonb_build_object((select id from ids where name='secret')::text, 'PO-77'));
reset role;
select pg_temp.login('cf100000-0000-4000-9000-000000000003'); set local role authenticated;
select pg_temp.assert(not exists (select 1 from public.asset_field_definitions where label='Purchase ref'), '[4] the operator does not see a managers field');
select pg_temp.assert(not exists (select 1 from public.asset_field_values where value_text='PO-77'), '[4] nor its value');
select pg_temp.assert(exists (select 1 from public.asset_field_values where value_text='North'), '[4] the operator sees everyone fields');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "Red"}')$q$, (select id from ids where name='colour')), '%forbidden%'),
  '[4] an operator cannot change values (machine edits are owner and manager)');
reset role;
select pg_temp.login('cf100000-0000-4000-9000-000000000002'); set local role authenticated;
select pg_temp.assert(exists (select 1 from public.asset_field_values where value_text='PO-77'), '[4] the manager sees it');
reset role;

-- == [5] Rename and retire keep every value ====================================================
select pg_temp.login('cf100000-0000-4000-9000-000000000001'); set local role authenticated;
select public.asset_field_update((select id from ids where name='colour'), 'Paint colour');
select pg_temp.assert((select label from public.asset_field_definitions where id=(select id from ids where name='colour'))='Paint colour'
  and (select key from public.asset_field_definitions where id=(select id from ids where name='colour'))='colour'
  and exists (select 1 from public.asset_field_values where value_text='Green <b>bold</b>'), '[5] a rename keeps the key and the value');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_update('%s', null, null, array['South'])$q$, (select id from ids where name='site')), '%custom-field-choice-in-use%'),
  '[5] a choice still used by an asset cannot be removed');
select public.asset_field_retire((select id from ids where name='colour'));
select pg_temp.assert(exists (select 1 from public.asset_field_values where value_text='Green <b>bold</b>'), '[5] retiring keeps the value');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "Red"}')$q$, (select id from ids where name='colour')), '%custom-field-retired%'),
  '[5] a retired field takes no new value');
select public.asset_field_retire((select id from ids where name='colour'), false);
select public.asset_field_set('cf200000-0000-4000-9000-000000000001', jsonb_build_object((select id from ids where name='colour')::text, 'Red'));
select pg_temp.assert(exists (select 1 from public.asset_field_values where value_text='Red'), '[5] a field brought back works again');
reset role;

-- == [6] Another business sees nothing and changes nothing ====================================
select pg_temp.login('cf100000-0000-4000-9000-000000000005'); set local role authenticated;
select pg_temp.assert(not exists (select 1 from public.asset_field_definitions), '[6] no other business''s definitions');
select pg_temp.assert(not exists (select 1 from public.asset_field_values), '[6] no other business''s values');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000003', '{"%s": "Blue"}')$q$, (select id from ids where name='colour')), '%forbidden%'),
  '[6] another business''s field cannot be used on my asset');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_set('cf200000-0000-4000-9000-000000000001', '{"%s": "Blue"}')$q$, (select id from ids where name='colour')), '%forbidden%'),
  '[6] nor on their asset');
select pg_temp.assert(pg_temp.raises(format($q$select public.asset_field_update('%s', 'Mine now')$q$, (select id from ids where name='colour')), '%forbidden%'),
  '[6] nor renamed');
reset role;

-- == [7] Billing and engines are untouched; the audit log has every change ====================
select pg_temp.assert((select profile::text from public.machines where id='cf200000-0000-4000-9000-000000000001')='full',
  '[7] custom fields never change an asset''s billing profile');
select pg_temp.assert((select count(*) from public.audit_log where entity='asset_field_values') >= 5
  and (select count(*) from public.audit_log where entity='asset_field_definitions') >= 6, '[7] every change is in the audit log');
select pg_temp.assert(not has_table_privilege('authenticated','public.asset_field_values','INSERT')
  and not has_table_privilege('authenticated','public.asset_field_definitions','UPDATE'), '[7] writes go only through the checked functions');

rollback;
