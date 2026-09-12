-- Durable, service-only push leases. Keep operational state out of notifications:
-- recipients can update their notification's read status, but cannot claim delivery.
create table public.notification_push_delivery (
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  claim_id uuid,
  claim_until timestamptz,
  retry_after timestamptz,
  delivered_subscription_ids uuid[] not null default '{}'
);
alter table public.notification_push_delivery enable row level security;
revoke all on public.notification_push_delivery from public, anon, authenticated;
grant select, insert, update, delete on public.notification_push_delivery to service_role;

create or replace function public.claim_notification_push(p_claim_id uuid, p_limit integer default 25)
returns table (
  id uuid, user_id uuid, farm_id uuid, template text, payload jsonb,
  delivered_subscription_ids uuid[]
)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_claim_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid push claim' using errcode = '22023';
  end if;
  insert into public.notification_push_delivery (notification_id)
    select n.id from public.notifications n
    where n.deleted_at is null and n.push_sent_at is null and n.user_id is not null
      and (n.deliver_after is null or n.deliver_after <= clock_timestamp())
      and not exists (select 1 from public.notification_push_delivery d where d.notification_id = n.id)
    order by n.created_at, n.id limit p_limit
    on conflict (notification_id) do nothing;
  return query
    with candidates as materialized (
      select d.notification_id from public.notification_push_delivery d
      join public.notifications n on n.id = d.notification_id
      where n.deleted_at is null and n.push_sent_at is null and n.user_id is not null
        and (n.deliver_after is null or n.deliver_after <= clock_timestamp())
        and (d.claim_until is null or d.claim_until <= clock_timestamp())
        and (d.retry_after is null or d.retry_after <= clock_timestamp())
      order by n.created_at, n.id limit p_limit for update of d skip locked
    ), claimed as (
      update public.notification_push_delivery d
      set claim_id = p_claim_id, claim_until = clock_timestamp() + interval '5 minutes'
      from candidates c where d.notification_id = c.notification_id
      returning d.notification_id, d.delivered_subscription_ids
    )
    select n.id, n.user_id, n.farm_id, n.template, n.payload, c.delivered_subscription_ids
    from claimed c join public.notifications n on n.id = c.notification_id;
end $$;

-- Persist each accepted device immediately: retries must not resend successful siblings.
create or replace function public.ack_notification_push(
  p_notification_id uuid, p_claim_id uuid, p_subscription_id uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.notification_push_delivery d
  set delivered_subscription_ids = case
    when p_subscription_id = any(d.delivered_subscription_ids) then d.delivered_subscription_ids
    else array_append(d.delivered_subscription_ids, p_subscription_id) end
  where d.notification_id = p_notification_id and d.claim_id = p_claim_id
    and d.claim_until > clock_timestamp() and p_subscription_id is not null
    and exists (
      select 1 from public.notifications n join public.push_subscriptions s on s.user_id = n.user_id
      where n.id = d.notification_id and s.id = p_subscription_id
    );
  return found;
end $$;

create or replace function public.finish_notification_push(
  p_notification_id uuid, p_claim_id uuid, p_terminal boolean
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.notification_push_delivery d
    where d.notification_id = p_notification_id and d.claim_id = p_claim_id
      and d.claim_until > clock_timestamp() for update;
  if not found or p_terminal is null then return false; end if;
  if p_terminal then
    update public.notifications set push_sent_at = clock_timestamp()
      where id = p_notification_id and push_sent_at is null;
  end if;
  update public.notification_push_delivery
    set claim_id = null, claim_until = null,
      retry_after = case when p_terminal then null else clock_timestamp() + interval '5 minutes' end
    where notification_id = p_notification_id;
  return true;
end $$;

revoke all on function public.claim_notification_push(uuid, integer) from public, anon, authenticated;
revoke all on function public.ack_notification_push(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_notification_push(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_notification_push(uuid, integer) to service_role;
grant execute on function public.ack_notification_push(uuid, uuid, uuid) to service_role;
grant execute on function public.finish_notification_push(uuid, uuid, boolean) to service_role;
