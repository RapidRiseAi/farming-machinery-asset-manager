-- 0001_extensions_and_enums.sql
-- Extensions and all enum types used across the schema.

create extension if not exists pgcrypto;   -- gen_random_uuid()

create type user_role            as enum ('rr_admin','owner','manager','mechanic','workshop','operator');
create type farm_tier            as enum ('starter','standard','large');
create type farm_status          as enum ('trial','active','suspended','cancelled');
create type machine_type         as enum ('tractor','harvester','bakkie','truck','implement','pump_generator','atv_other');
create type machine_status       as enum ('active','in_workshop','standby','retired','sold');
create type meter_type           as enum ('hours','km','none');
create type meter_source         as enum ('qr','job','manual','whatsapp');
create type service_line_status  as enum ('ok','due_soon','overdue');
create type fault_urgency        as enum ('can_work','limping','stopped');
create type fault_status         as enum ('open','in_job','scheduled','resolved');
create type job_card_type        as enum ('scheduled_service','repair','inspection','other');
create type job_card_status      as enum ('reported','open','in_progress','waiting_parts','completed','approved');
create type job_line_kind        as enum ('part','labour','other');
create type watch_item_status    as enum ('open','done','dismissed');
create type attachment_kind      as enum ('photo','invoice','doc','voice');
create type notification_channel as enum ('whatsapp','inapp','email');
create type notification_status  as enum ('queued','sent','delivered','failed');
create type workshop_link_status as enum ('pending','active','revoked');
create type app_language         as enum ('en','af');
