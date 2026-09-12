\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values
 ('fe000000-0000-0000-0000-000000000001','Push lease test','professional','active');
insert into auth.users(id,email) values
 ('fe100000-0000-0000-0000-000000000001','push-one@example.test'),
 ('fe100000-0000-0000-0000-000000000002','push-two@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fe100000-0000-0000-0000-000000000001','fe000000-0000-0000-0000-000000000001','owner','Push one','push-one@example.test'),
 ('fe100000-0000-0000-0000-000000000002','fe000000-0000-0000-0000-000000000001','manager','Push two','push-two@example.test');
insert into public.push_subscriptions(id,farm_id,user_id,endpoint,p256dh,auth) values
 ('fe200000-0000-0000-0000-000000000001','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','https://fcm.googleapis.com/fcm/send/lease-one','stub','stub'),
 ('fe200000-0000-0000-0000-000000000002','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000002','https://fcm.googleapis.com/fcm/send/lease-two','stub','stub');
insert into public.notifications(id,farm_id,user_id,channel,template,created_at,deliver_after,deleted_at,push_sent_at) values
 ('fe300000-0000-0000-0000-000000000001','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','inapp','service_due_soon','2000-01-01',null,null,null),
 ('fe300000-0000-0000-0000-000000000002','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','inapp','service_due_soon','2000-01-02',null,null,null),
 ('fe300000-0000-0000-0000-000000000003','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','inapp','service_due_soon','2000-01-03',now()+interval '1 day',null,null),
 ('fe300000-0000-0000-0000-000000000004','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','inapp','service_due_soon','2000-01-04',null,now(),null),
 ('fe300000-0000-0000-0000-000000000005','fe000000-0000-0000-0000-000000000001',null,'inapp','service_due_soon','2000-01-05',null,null,null),
 ('fe300000-0000-0000-0000-000000000006','fe000000-0000-0000-0000-000000000001','fe100000-0000-0000-0000-000000000001','inapp','service_due_soon','2000-01-06',null,null,now());

do $$ begin
 if has_table_privilege('authenticated','public.notification_push_delivery','SELECT')
   or has_table_privilege('authenticated','public.notification_push_delivery','UPDATE')
   or has_table_privilege('anon','public.notification_push_delivery','SELECT') then
   raise exception 'PUSH FAIL: delivery state exposed to clients';
 end if;
 if has_function_privilege('authenticated','public.claim_notification_push(uuid,integer)','EXECUTE')
   or has_function_privilege('anon','public.claim_notification_push(uuid,integer)','EXECUTE')
   or has_function_privilege('authenticated','public.ack_notification_push(uuid,uuid,uuid)','EXECUTE')
   or has_function_privilege('authenticated','public.finish_notification_push(uuid,uuid,boolean)','EXECUTE')
   or not has_function_privilege('service_role','public.claim_notification_push(uuid,integer)','EXECUTE') then
   raise exception 'PUSH FAIL: claim/ack/finish are not service-only';
 end if;
end $$;

set role service_role;
do $$
declare
 first_note uuid := 'fe300000-0000-0000-0000-000000000001';
 second_note uuid := 'fe300000-0000-0000-0000-000000000002';
 first_claim uuid := 'fe400000-0000-0000-0000-000000000001';
 second_claim uuid := 'fe400000-0000-0000-0000-000000000002';
 third_claim uuid := 'fe400000-0000-0000-0000-000000000003';
 own_device uuid := 'fe200000-0000-0000-0000-000000000001';
 other_device uuid := 'fe200000-0000-0000-0000-000000000002';
 claimed uuid[];
 denied boolean := false;
begin
 begin perform public.claim_notification_push(first_claim, 101);
 exception when invalid_parameter_value then denied := true; end;
 if not denied then raise exception 'PUSH FAIL: unbounded claim accepted'; end if;
 select array_agg(id) into claimed from public.claim_notification_push(first_claim, 1);
 if claimed is distinct from array[first_note] then raise exception 'PUSH FAIL: oldest bounded claim'; end if;
 select array_agg(id) into claimed from public.claim_notification_push(second_claim, 1);
 if claimed is distinct from array[second_note] then raise exception 'PUSH FAIL: another worker reclaimed a live lease'; end if;
 if exists (select 1 from public.claim_notification_push(third_claim, 100)
             where farm_id='fe000000-0000-0000-0000-000000000001') then
   raise exception 'PUSH FAIL: future/deleted/sent/unaddressed/claimed rows eligible'; end if;

 if public.ack_notification_push(first_note, second_claim, own_device)
   or public.ack_notification_push(first_note, first_claim, other_device)
   or public.finish_notification_push(first_note, second_claim, true) then
   raise exception 'PUSH FAIL: unrelated claim/device changed delivery'; end if;
 if not public.ack_notification_push(first_note, first_claim, own_device)
   or not public.ack_notification_push(first_note, first_claim, own_device) then
   raise exception 'PUSH FAIL: owning worker could not acknowledge'; end if;
 if (select delivered_subscription_ids from public.notification_push_delivery where notification_id=first_note)
   is distinct from array[own_device] then raise exception 'PUSH FAIL: repeated ack duplicated device'; end if;
 if not public.finish_notification_push(first_note, first_claim, false) then raise exception 'PUSH FAIL: could not defer'; end if;
 if (select push_sent_at from public.notifications where id=first_note) is not null then
   raise exception 'PUSH FAIL: retry marked sent'; end if;
 if exists(select 1 from public.claim_notification_push(third_claim,100) where id=first_note) then
   raise exception 'PUSH FAIL: retry backoff ignored'; end if;

 update public.notification_push_delivery set retry_after=now()-interval '1 second' where notification_id=first_note;
 select array_agg(id) into claimed from public.claim_notification_push(third_claim,1);
 if claimed is distinct from array[first_note] then raise exception 'PUSH FAIL: due retry not reclaimed'; end if;
 if (select delivered_subscription_ids from public.notification_push_delivery where notification_id=first_note)
   is distinct from array[own_device] then raise exception 'PUSH FAIL: retry lost accepted devices'; end if;
 if public.finish_notification_push(first_note,first_claim,true) then raise exception 'PUSH FAIL: old claim can finalize new lease'; end if;
 if not public.finish_notification_push(first_note,third_claim,true) then
   raise exception 'PUSH FAIL: terminal completion rejected'; end if;
 -- Read after the mutation in a separate statement; a subquery in the same IF
 -- expression can be evaluated before the mutating function.
 if (select push_sent_at from public.notifications where id=first_note) is null then
   raise exception 'PUSH FAIL: terminal completion not persisted'; end if;

 update public.notification_push_delivery set claim_until=now()-interval '1 second' where notification_id=second_note;
 if public.ack_notification_push(second_note,second_claim,own_device)
   or public.finish_notification_push(second_note,second_claim,true) then
   raise exception 'PUSH FAIL: expired worker retains ownership'; end if;
 select array_agg(id) into claimed from public.claim_notification_push(first_claim,1);
 if claimed is distinct from array[second_note] then raise exception 'PUSH FAIL: crashed worker lease not recovered'; end if;
 if not public.finish_notification_push(second_note,first_claim,true) then raise exception 'PUSH FAIL: recovered lease cannot finish'; end if;
end $$;
reset role;
rollback;
\echo 'Notification push lease tests passed.'
