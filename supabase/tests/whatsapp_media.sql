-- WhatsApp voice notes and photos (20261104210000): what the receiver stores, what the
-- staging table allows, what the prune clears, and who may touch any of it.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values
 ('fb000000-0000-0000-0000-000000000001','WhatsApp Media','complete','active'),
 ('fb000000-0000-0000-0000-000000000002','WhatsApp Other','complete','active');
insert into auth.users(id,email) values ('fb100000-0000-0000-0000-000000000001','wa-media@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fb100000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000001','owner','M','wa-media@example.test');
insert into public.whatsapp_links(id,user_id,farm_id,phone,assistant_enabled,notifications_enabled,linked_at) values
 ('fb300000-0000-0000-0000-000000000001','fb100000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000001',
  '27820000091',true,false,now()-interval '1 hour');

-- (a) Private to the service, like the rest of the channel.
do $$ begin
 if has_table_privilege('authenticated','public.whatsapp_media','SELECT')
   or has_table_privilege('anon','public.whatsapp_media','SELECT')
   or has_table_privilege('authenticated','public.whatsapp_media','INSERT')
   or has_function_privilege('authenticated','public.whatsapp_receive(text,text,text,timestamptz,text,text,text)','EXECUTE')
   or has_function_privilege('anon','public.whatsapp_receive(text,text,text,timestamptz,text,text,text)','EXECUTE') then
   raise exception 'WA MEDIA FAIL [a]: staged media or the receiver is reachable from a browser role'; end if;
 if to_regprocedure('public.whatsapp_receive(text,text,text,timestamptz)') is not null then
   raise exception 'WA MEDIA FAIL [a]: the four-argument receiver still exists beside the new one'; end if;
end $$;

-- (b) The receiver stores a voice note's and a photo's media id, never bytes.
set role service_role;
select public.whatsapp_receive('wm-photo','27820000091','leak under the cab',now(),'image','media-img-1','image/jpeg');
select public.whatsapp_receive('wm-voice','27820000091','',now(),'audio','media-aud-1','audio/ogg; codecs=opus');
-- A webhook still on the four-argument call keeps working through a deploy.
select public.whatsapp_receive('wm-text','27820000091','status',now());
-- A media kind we do not handle, or a media message with no id, stores nothing.
select public.whatsapp_receive('wm-video','27820000091','',now(),'video','media-vid-1','video/mp4');
select public.whatsapp_receive('wm-noid','27820000091','',now(),'image','',null);
-- "STOP" as a photo caption is a caption, not an opt-out.
select public.whatsapp_receive('wm-stop-caption','27820000091','STOP',now(),'image','media-img-2','image/jpeg');
reset role;
do $$ declare r public.whatsapp_inbox; begin
 select * into r from public.whatsapp_inbox where provider_id='wm-photo';
 if r.media_kind is distinct from 'image' or r.media_id is distinct from 'media-img-1'
    or r.message_text is distinct from 'leak under the cab' or r.media_mime is distinct from 'image/jpeg' then
   raise exception 'WA MEDIA FAIL [b]: photo stored as % / % / "%"', r.media_kind, r.media_id, r.message_text; end if;
 select * into r from public.whatsapp_inbox where provider_id='wm-voice';
 if r.media_kind is distinct from 'audio' or r.media_id is distinct from 'media-aud-1' or r.message_text <> '' then
   raise exception 'WA MEDIA FAIL [b]: voice note stored as % / %', r.media_kind, r.media_id; end if;
 if not exists(select 1 from public.whatsapp_inbox where provider_id='wm-text' and media_kind is null and message_text='status') then
   raise exception 'WA MEDIA FAIL [b]: the four-argument call stopped storing text'; end if;
 if exists(select 1 from public.whatsapp_inbox where provider_id in ('wm-video','wm-noid')) then
   raise exception 'WA MEDIA FAIL [b]: an unhandled media kind or a media message with no id was queued'; end if;
 if (select revoked_at from public.whatsapp_links where id='fb300000-0000-0000-0000-000000000001') is not null then
   raise exception 'WA MEDIA FAIL [b]: a photo captioned STOP revoked the link'; end if;
end $$;

-- (c) A staged photo lives in its own farm's folder, once per message, attached only with an attachment.
do $$ declare v_inbox uuid; v_ok boolean; begin
 select id into v_inbox from public.whatsapp_inbox where provider_id='wm-photo';
 v_ok := false;
 begin
   insert into public.whatsapp_media(inbox_id,link_id,farm_id,user_id,kind,bucket,storage_path,mime,bytes)
   values (v_inbox,'fb300000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000001',
     'fb100000-0000-0000-0000-000000000001','image','fault-photos',
     'fb000000-0000-0000-0000-000000000002/whatsapp/x/abc.jpg','image/jpeg',100);
 exception when check_violation then v_ok := true; end;
 if not v_ok then raise exception 'WA MEDIA FAIL [c]: a photo was staged in another farm''s folder'; end if;

 insert into public.whatsapp_media(inbox_id,link_id,farm_id,user_id,kind,bucket,storage_path,mime,bytes)
 values (v_inbox,'fb300000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000001',
   'fb100000-0000-0000-0000-000000000001','image','fault-photos',
   'fb000000-0000-0000-0000-000000000001/whatsapp/fb300000/abc.jpg','image/jpeg',100);

 v_ok := false;
 begin
   insert into public.whatsapp_media(inbox_id,link_id,farm_id,user_id,kind,bucket,storage_path,mime,bytes)
   values (v_inbox,'fb300000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000001',
     'fb100000-0000-0000-0000-000000000001','image','fault-photos',
     'fb000000-0000-0000-0000-000000000001/whatsapp/fb300000/def.jpg','image/jpeg',100);
 exception when unique_violation then v_ok := true; end;
 if not v_ok then raise exception 'WA MEDIA FAIL [c]: one message staged two photos'; end if;

 v_ok := false;
 begin
   update public.whatsapp_media set state='attached' where inbox_id=v_inbox;
 exception when check_violation then v_ok := true; end;
 if not v_ok then raise exception 'WA MEDIA FAIL [c]: a photo was marked attached with no attachment'; end if;

 v_ok := false;
 begin
   update public.whatsapp_media set mime='image/svg+xml' where inbox_id=v_inbox;
 exception when check_violation then v_ok := true; end;
 if not v_ok then raise exception 'WA MEDIA FAIL [c]: a staged file was allowed a non-photo type'; end if;
end $$;

-- (d) The prune clears the provider's media reference with the text, after 30 days.
update public.whatsapp_inbox set created_at = now() - interval '31 days' where provider_id='wm-voice';
set role service_role;
select public.whatsapp_prune();
reset role;
do $$ declare r public.whatsapp_inbox; begin
 select * into r from public.whatsapp_inbox where provider_id='wm-voice';
 if r.media_id is not null or r.media_kind is not null or r.media_mime is not null then
   raise exception 'WA MEDIA FAIL [d]: a 31-day-old voice note kept its media reference'; end if;
 if (select media_id from public.whatsapp_inbox where provider_id='wm-photo') is null then
   raise exception 'WA MEDIA FAIL [d]: the prune cleared a message that is not 30 days old'; end if;
end $$;

rollback;
