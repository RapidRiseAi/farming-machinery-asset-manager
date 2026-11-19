-- WhatsApp completion (B4, 20261121090000): capability flags per path, statuses that only move
-- forward, one answer per message, photos on the customer's storage pool, and app upload links
-- that only ever open for their own person. Scenario 33.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'WA COMPLETE FAIL: %', why; end if; end $$;
create function pg_temp.raises(p_sql text, p_like text) returns boolean language plpgsql as $$
begin execute p_sql; return false; exception when others then return sqlerrm like p_like; end $$;

insert into public.farms(id,name,plan,status) values
 ('fc000000-0000-4000-9000-000000000001','WA Complete','complete','active'),
 ('fc000000-0000-4000-9000-000000000002','WA Other','complete','active');
insert into auth.users(id,email) values
 ('fc100000-0000-4000-9000-000000000001','wa-c1@example.test'),
 ('fc100000-0000-4000-9000-000000000002','wa-c2@example.test');
insert into public.users(id,farm_id,role,name,email,active) values
 ('fc100000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','owner','One','wa-c1@example.test',true),
 ('fc100000-0000-4000-9000-000000000002','fc000000-0000-4000-9000-000000000002','owner','Two','wa-c2@example.test',true);
insert into public.whatsapp_links(id,user_id,farm_id,phone,assistant_enabled,notifications_enabled,linked_at) values
 ('fc300000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001',
  '27820000071',true,true,now()-interval '1 hour');
insert into public.machines(id,farm_id,name,type) values
 ('fc200000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','Tractor','tractor'),
 ('fc200000-0000-4000-9000-000000000002','fc000000-0000-4000-9000-000000000002','Other tractor','tractor');
insert into public.faults(id,farm_id,machine_id,description,status) values
 ('fc400000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc200000-0000-4000-9000-000000000001','Leak','open'),
 ('fc400000-0000-4000-9000-000000000002','fc000000-0000-4000-9000-000000000002','fc200000-0000-4000-9000-000000000002','Other','open');

-- == [1] Capability flags: text and alerts released, photos and voice in testing ============
select pg_temp.assert(app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','whatsapp_text'), '[1] text is released (verified 17 Oct)');
select pg_temp.assert(app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','whatsapp_alerts'), '[1] alerts are released (verified 18 Oct)');
select pg_temp.assert(not app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','whatsapp_photos'), '[1] photos stay off until the phone test');
select pg_temp.assert(not app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','whatsapp_voice'), '[1] voice stays off until the phone test');
insert into public.farm_feature_access(key,farm_id) values ('whatsapp_photos','fc000000-0000-4000-9000-000000000001');
select pg_temp.assert(app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','whatsapp_photos'), '[1] a testing business gets photos');
select pg_temp.assert(not app.whatsapp_capability('fc000000-0000-4000-9000-000000000002','whatsapp_photos'), '[1] another business does not');
select pg_temp.assert(not app.whatsapp_capability('fc000000-0000-4000-9000-000000000001','map'), '[1] only the four WhatsApp paths answer');
select pg_temp.assert(not has_function_privilege('authenticated','public.whatsapp_capability(uuid,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.whatsapp_record_status(text,text,boolean)','EXECUTE')
  and not has_function_privilege('authenticated','public.whatsapp_start_answer(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.whatsapp_stage_photo(uuid,uuid,uuid,uuid,text,text,bigint)','EXECUTE')
  and not has_function_privilege('authenticated','public.whatsapp_photo_removed(uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.whatsapp_upload_link_create(text,uuid,text,text,uuid)','EXECUTE')
  and not has_table_privilege('authenticated','public.whatsapp_upload_links','SELECT'),
  '[1] the worker functions and the link table are the service''s alone');

-- == [2] Statuses only move forward ==========================================================
set role service_role;
select public.whatsapp_receive('wc-1','27820000071','hello',now());
select public.whatsapp_receive('wc-2','27820000071','again',now());
reset role;
update public.whatsapp_inbox set provider_reply_id='wamid.r1', state='sent' where provider_id='wc-1';
update public.whatsapp_inbox set provider_reply_id='wamid.r2', state='sent' where provider_id='wc-2';
select public.whatsapp_record_status('wamid.r1','read',true);
select public.whatsapp_record_status('wamid.r1','sent',null);
select public.whatsapp_record_status('wamid.r1','delivered',null);
select pg_temp.assert((select delivery_status from public.whatsapp_inbox where provider_id='wc-1')='read',
  '[2] a late sent or delivered never undoes a read');
select pg_temp.assert((select delivery_chargeable from public.whatsapp_inbox where provider_id='wc-1'), '[2] Meta''s chargeable answer is kept');
select public.whatsapp_record_status('wamid.r2','sent',null);
select public.whatsapp_record_status('wamid.r2','failed',null);
select pg_temp.assert((select delivery_status from public.whatsapp_inbox where provider_id='wc-2')='failed', '[2] a failure after a send is kept');
select public.whatsapp_record_status('wamid.r2','delivered',false);
select pg_temp.assert((select delivery_status from public.whatsapp_inbox where provider_id='wc-2')='delivered'
  and (select delivery_chargeable from public.whatsapp_inbox where provider_id='wc-2') = false,
  '[2] a delivery outranks a failure, and a free message is recorded as free');
select public.whatsapp_record_status('wamid.r2','failed',null);
select pg_temp.assert((select delivery_status from public.whatsapp_inbox where provider_id='wc-2')='delivered',
  '[2] a failure never undoes a delivery');
select pg_temp.assert(pg_temp.raises($q$select public.whatsapp_record_status('wamid.r2','played',null)$q$, '%whatsapp-status-invalid%'),
  '[2] an unknown status is refused');

-- == [3] One answer per message ==============================================================
update public.whatsapp_inbox set lease_id='fc900000-0000-4000-9000-000000000001', reply=null where provider_id='wc-1';
select pg_temp.assert(public.whatsapp_start_answer((select id from public.whatsapp_inbox where provider_id='wc-1'),
  'fc900000-0000-4000-9000-000000000001'), '[3] the first attempt may answer');
select pg_temp.assert(not public.whatsapp_start_answer((select id from public.whatsapp_inbox where provider_id='wc-1'),
  'fc900000-0000-4000-9000-000000000001'), '[3] a second attempt never asks the model again');
update public.whatsapp_inbox set lease_id='fc900000-0000-4000-9000-000000000002', answer_started_at=null where provider_id='wc-2';
select pg_temp.assert(not public.whatsapp_start_answer((select id from public.whatsapp_inbox where provider_id='wc-2'),
  'fc900000-0000-4000-9000-000000000009'), '[3] another lease cannot start it');

-- == [4] Photos on the customer's storage pool ===============================================
insert into app.storage_quota_overrides(farm_id, quota_bytes, reason) values ('fc000000-0000-4000-9000-000000000001', 3000, 'B4 test: a tiny pool');
select public.whatsapp_stage_photo((select id from public.whatsapp_inbox where provider_id='wc-1'),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000001/whatsapp/fc300000-0000-4000-9000-000000000001/a.jpg','image/jpeg',2000);
select pg_temp.assert((select count(*) from public.upload_intents where target_kind='whatsapp_media' and status='finalised'
  and counts_against_quota and object_removed_at is null and actual_bytes=2000)=1, '[4] a staged photo counts against the pool at once');
select pg_temp.assert(app.storage_pool_usage(array['fc000000-0000-4000-9000-000000000001'::uuid]) >= 2000, '[4] the pool sees it');
-- A replay of the same message answers with the same row and reserves nothing more.
select public.whatsapp_stage_photo((select id from public.whatsapp_inbox where provider_id='wc-1'),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000001/whatsapp/fc300000-0000-4000-9000-000000000001/a.jpg','image/jpeg',2000);
select pg_temp.assert((select count(*) from public.whatsapp_media where farm_id='fc000000-0000-4000-9000-000000000001')=1
  and (select count(*) from public.upload_intents where target_kind='whatsapp_media')=1, '[4] a replay stages nothing twice');
-- Over the pool: refused, nothing recorded.
select pg_temp.assert(pg_temp.raises($q$select public.whatsapp_stage_photo((select id from public.whatsapp_inbox where provider_id='wc-2'),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000001/whatsapp/fc300000-0000-4000-9000-000000000001/b.jpg','image/jpeg',1500)$q$, '%upload:storage_full%'),
  '[4] a full pool refuses the photo');
select pg_temp.assert((select count(*) from public.whatsapp_media where inbox_id=(select id from public.whatsapp_inbox where provider_id='wc-2'))=0,
  '[4] nothing staged when the pool refuses');
-- Discarded: the bytes leave the pool, and the next photo fits.
update public.whatsapp_media set state='discarded', settled_at=now() where farm_id='fc000000-0000-4000-9000-000000000001';
select public.whatsapp_photo_removed((select id from public.whatsapp_media where farm_id='fc000000-0000-4000-9000-000000000001'));
select pg_temp.assert((select object_removed_at is not null from public.upload_intents where target_kind='whatsapp_media'),
  '[4] a discarded photo frees its bytes');
select public.whatsapp_stage_photo((select id from public.whatsapp_inbox where provider_id='wc-2'),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000001/whatsapp/fc300000-0000-4000-9000-000000000001/b.jpg','image/jpeg',1500);
-- Attached: it stays counted as the fault photo it became.
insert into public.attachments(id,farm_id,parent_type,parent_id,kind,storage_path,created_by)
select id, farm_id, 'fault', 'fc400000-0000-4000-9000-000000000001', 'photo', storage_path, user_id
  from public.whatsapp_media where inbox_id=(select id from public.whatsapp_inbox where provider_id='wc-2');
update public.whatsapp_media set state='attached', attachment_id=id, settled_at=now()
 where inbox_id=(select id from public.whatsapp_inbox where provider_id='wc-2');
select public.whatsapp_photo_removed((select id from public.whatsapp_media where inbox_id=(select id from public.whatsapp_inbox where provider_id='wc-2')));
select pg_temp.assert((select object_removed_at is null from public.upload_intents where target_kind='whatsapp_media' and actual_bytes=1500),
  '[4] an attached photo keeps counting');
-- Another person's link, or a path outside the business's folder: refused.
select pg_temp.assert(pg_temp.raises($q$select public.whatsapp_stage_photo(gen_random_uuid(),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000002','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000002/whatsapp/x/c.jpg','image/jpeg',10)$q$, '%forbidden%'),
  '[4] a link stages only into its own business');
select pg_temp.assert(pg_temp.raises($q$select public.whatsapp_stage_photo((select id from public.whatsapp_inbox where provider_id='wc-1'),
  'fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','fc100000-0000-4000-9000-000000000001',
  'fc000000-0000-4000-9000-000000000002/whatsapp/x/d.jpg','image/jpeg',10)$q$, '%whatsapp-photo-invalid%')
  or (select count(*) from public.whatsapp_media where storage_path like 'fc000000-0000-4000-9000-000000000002%')=0,
  '[4] never a path in another business''s folder');

-- == [5] App upload links open only for their own person =====================================
select public.whatsapp_upload_link_create(repeat('a',64),'fc300000-0000-4000-9000-000000000001','fault_photo','fault','fc400000-0000-4000-9000-000000000001');
select public.whatsapp_upload_link_create(repeat('b',64),'fc300000-0000-4000-9000-000000000001','document');
select pg_temp.assert(pg_temp.raises($q$select public.whatsapp_upload_link_create(repeat('c',64),
  'fc300000-0000-4000-9000-000000000001','fault_photo','fault','fc400000-0000-4000-9000-000000000002')$q$, '%forbidden%'),
  '[5] a link never names another business''s fault');
select pg_temp.assert((select count(*) from public.whatsapp_upload_links)=2, '[5] only the hash is kept, two links');

select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.assert((public.whatsapp_upload_link_open(repeat('a',64))->>'ok')::boolean
  and public.whatsapp_upload_link_open(repeat('a',64))->>'target_id'='fc400000-0000-4000-9000-000000000001',
  '[5] the person opens their own link, for the fault it names');
select pg_temp.assert(public.whatsapp_upload_link_open(repeat('f',64))->>'reason'='unknown', '[5] an unknown token');
reset role;
select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.assert(public.whatsapp_upload_link_open(repeat('a',64))->>'reason'='unknown',
  '[5] a forwarded link answers another person exactly as an unknown one');
reset role;
select set_config('request.jwt.claims','',true);
update public.whatsapp_upload_links set expires_at=now()-interval '1 minute' where token_hash=repeat('b',64);
update public.users set active=false where id='fc100000-0000-4000-9000-000000000001';
select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.assert(public.whatsapp_upload_link_open(repeat('b',64))->>'reason'='expired', '[5] an expired link');
select pg_temp.assert(public.whatsapp_upload_link_open(repeat('a',64))->>'reason'='not_member', '[5] a person no longer on the business');
reset role;
select set_config('request.jwt.claims','',true);

rollback;
