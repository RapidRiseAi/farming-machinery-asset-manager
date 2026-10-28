-- 20261028101100_admin_client.sql
-- One read of a client for Rapid Rise's client page (/admin/farms/[id]).
--
-- What a person helping a customer needs in one place, most of which was in tables the app
-- could only reach with the service key (sign-in times in auth.users, WhatsApp links and the
-- delivery queues): the people with their last sign-in and whether they ever signed in, how
-- much the farm uses the product, whether its alerts are reaching anyone, and the support
-- visits made to it.
--
-- SECURITY DEFINER behind app.is_rr_support() (two-step, never a test account), granted to
-- `authenticated` and called with the admin's own session, so no page needs the service key
-- for it. Deliberately reads no billing table (the lockdown in billing_subscription.sql): the
-- page reads billing through the admin's own RLS, which already admits Rapid Rise. No
-- WhatsApp numbers and no message text: whether each person is linked, and failure counts
-- with the provider's error code.

create or replace function public.admin_client(p_farm uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_month date := date_trunc('month', (now() at time zone 'Africa/Johannesburg'))::date;
  v jsonb;
begin
  if not app.is_rr_support() then
    raise exception 'Rapid Rise support only.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.farms f where f.id = p_farm) then
    return null;
  end if;

  select jsonb_build_object(
    'farm', (
      select jsonb_build_object(
        'id', f.id, 'name', f.name, 'is_test', f.is_test, 'plan', f.plan,
        'billing_period', f.billing_period, 'status', f.status, 'asset_count', f.asset_count,
        'created_at', f.created_at, 'billing_email', f.billing_email, 'deleted_at', f.deleted_at)
        from public.farms f where f.id = p_farm),

    -- Everyone on the farm: its own people and members from elsewhere.
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'role', p.role, 'email', p.email, 'phone', p.phone,
               'active', p.active, 'home', p.home, 'last_sign_in_at', p.last_sign_in_at,
               'whatsapp_linked', p.wa_linked, 'whatsapp_alerts', p.wa_alerts)
               order by case p.role when 'owner' then 0 when 'manager' then 1 when 'mechanic' then 2 else 3 end,
                        p.name)
        from (
          select u.id, u.name, coalesce(m.role, u.role)::text as role, u.email, u.phone,
                 (u.active and coalesce(m.active, true)) as active,
                 (u.farm_id = p_farm) as home,
                 a.last_sign_in_at,
                 exists (select 1 from public.whatsapp_links l
                          where l.user_id = u.id and l.farm_id = p_farm
                            and l.revoked_at is null and l.expires_at > now()) as wa_linked,
                 exists (select 1 from public.whatsapp_links l
                          where l.user_id = u.id and l.farm_id = p_farm and l.notifications_enabled
                            and l.revoked_at is null and l.expires_at > now()) as wa_alerts
            from public.users u
            left join public.user_farm_memberships m
              on m.user_id = u.id and m.farm_id = p_farm and m.deleted_at is null
            left join auth.users a on a.id = u.id
           where u.deleted_at is null
             and (u.farm_id = p_farm or m.user_id is not null)
        ) p), '[]'::jsonb),

    'usage', jsonb_build_object(
      'machines', (select count(*) from public.machines mc where mc.farm_id = p_farm and mc.deleted_at is null),
      'open_faults', (select count(*) from public.faults ft
                       where ft.farm_id = p_farm and ft.deleted_at is null
                         and ft.status in ('open', 'acknowledged', 'in_progress', 'in_job', 'scheduled')),
      'jobs_30d', (select count(*) from public.job_cards jc
                    where jc.farm_id = p_farm and jc.deleted_at is null and jc.created_at > now() - interval '30 days'),
      'last_activity', greatest(
        (select max(jc.created_at) from public.job_cards jc where jc.farm_id = p_farm and jc.deleted_at is null),
        (select max(ft.created_at) from public.faults ft where ft.farm_id = p_farm and ft.deleted_at is null)),
      'ai_calls_month', (select count(*) from public.ai_usage au where au.farm_id = p_farm and au.month = v_month),
      'ai_failed_month', (select count(*) from public.ai_usage au
                           where au.farm_id = p_farm and au.month = v_month and au.outcome not in ('ok', 'fallback')),
      'ai_billed_cents_month', (select coalesce(round(sum(au.billed_cents)), 0) from public.ai_usage au
                                 where au.farm_id = p_farm and au.month = v_month)),

    'channels', jsonb_build_object(
      'whatsapp_linked', (select count(distinct l.user_id) from public.whatsapp_links l
                           where l.farm_id = p_farm and l.revoked_at is null and l.expires_at > now()),
      'whatsapp_alerts', (select count(distinct l.user_id) from public.whatsapp_links l
                           where l.farm_id = p_farm and l.notifications_enabled
                             and l.revoked_at is null and l.expires_at > now()),
      'email_failures_7d', (select count(*) from public.notification_email_delivery d
                              join public.notifications n on n.id = d.notification_id
                             where n.farm_id = p_farm and d.last_error is not null
                               and d.created_at > now() - interval '7 days'),
      'whatsapp_failures_7d', (select count(*) from public.whatsapp_notification_delivery w
                                 join public.whatsapp_links l on l.id = w.link_id
                                where l.farm_id = p_farm and w.state = 'failed'
                                  and w.created_at > now() - interval '7 days'),
      'recent_failures', coalesce((
        select jsonb_agg(x.item order by x.at desc)
          from (
            (select d.created_at as at,
                    jsonb_build_object('channel', 'email', 'at', d.created_at, 'template', n.template,
                                       'error', left(d.last_error, 120)) as item
               from public.notification_email_delivery d
               join public.notifications n on n.id = d.notification_id
              where n.farm_id = p_farm and d.last_error is not null
                and d.created_at > now() - interval '7 days'
              order by d.created_at desc limit 10)
            union all
            (select w.created_at,
                    jsonb_build_object('channel', 'whatsapp', 'at', w.created_at, 'template', n.template,
                                       'error', left(coalesce(w.error_code, w.delivery_status, w.state), 120))
               from public.whatsapp_notification_delivery w
               join public.whatsapp_links l on l.id = w.link_id
               join public.notifications n on n.id = w.notification_id
              where l.farm_id = p_farm and w.state = 'failed'
                and w.created_at > now() - interval '7 days'
              order by w.created_at desc limit 10)
          ) x), '[]'::jsonb)),

    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v2.id, 'started_at', v2.started_at, 'ended_at', v2.ended_at,
               'reason', v2.reason, 'ticket_id', v2.ticket_id, 'admin_name', v2.admin_name)
               order by v2.started_at desc)
        from (select sv.id, sv.started_at, sv.ended_at, sv.reason, sv.ticket_id, au.name as admin_name
                from public.support_visits sv
                left join public.users au on au.id = sv.admin_id
               where sv.farm_id = p_farm
               order by sv.started_at desc
               limit 20) v2), '[]'::jsonb)
  ) into v;
  return v;
end $$;

comment on function public.admin_client(uuid) is
  'Rapid Rise support''s view of one client: farm, people (last sign-in, WhatsApp linked), usage, '
  'alert delivery failures (no numbers, no text) and support visits. Reads no billing table.';

revoke execute on function public.admin_client(uuid) from public, anon;
grant execute on function public.admin_client(uuid) to authenticated;
