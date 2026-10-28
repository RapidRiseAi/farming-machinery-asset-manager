-- 20261028110900_asset_finance_calendar.sql
-- Instalments, contract notice days and contract ends on the farm calendar
-- (20260921130000), beside services, workshop bookings and document expiries.
--
-- Same two rules the calendar was built on:
--   * SECURITY INVOKER, so each source keeps its own RLS. finance_instalments and
--     asset_contracts are readable by owners and managers only (20261028110100), so a
--     mechanic or a driver calling this gets these rows from nobody, without a line here
--     saying so, and the calendar cannot widen what anybody sees.
--   * NO MONEY ON IT. The title is the lender or the other party, the detail the
--     agreement or contract reference; never an amount.
--
-- The finance items are their own function, which farm_calendar adds to its union.

create or replace function app.finance_calendar_items(p_farm uuid, p_from date, p_to date)
returns table (
  kind         calendar_item_kind,
  item_id      uuid,
  machine_id   uuid,
  machine_name text,
  title        text,
  detail       text,
  on_date      date,
  state        text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- Open instalments, the balloon included. Coming up inside the agreement's own
  -- reminder lead (seven days when it has none), overdue once the day has passed unpaid.
  select
    'finance_instalment'::calendar_item_kind,
    i.id, a.machine_id, m.name, a.lender, a.agreement_number, i.due_date,
    case when i.due_date < (now() at time zone 'Africa/Johannesburg')::date then 'overdue'
         when i.due_date <= (now() at time zone 'Africa/Johannesburg')::date + coalesce(a.reminder_lead_days, 7)
           then 'due_soon'
         else 'ok' end
  from finance_instalments i
  join finance_agreements a on a.id = i.agreement_id
  join machines m on m.id = a.machine_id
  where i.farm_id = p_farm
    and i.deleted_at is null and a.deleted_at is null and m.deleted_at is null
    and a.status = 'active' and i.status = 'open'
    and i.due_date between p_from and p_to

  union all

  -- The last day to give notice. Past it, an auto-renewing contract has renewed itself.
  select
    'contract_notice'::calendar_item_kind,
    c.id, c.machine_id, m.name, c.party, c.reference, c.notice_date,
    case when c.notice_date < (now() at time zone 'Africa/Johannesburg')::date then 'overdue'
         when c.notice_date <= (now() at time zone 'Africa/Johannesburg')::date + coalesce(c.reminder_lead_days, 30)
           then 'due_soon'
         else 'ok' end
  from asset_contracts c
  left join machines m on m.id = c.machine_id
  where c.farm_id = p_farm
    and c.deleted_at is null and c.status = 'active'
    and (c.machine_id is null or m.deleted_at is null)
    and c.notice_date is not null
    and c.notice_date between p_from and p_to

  union all

  -- The end of a contract.
  select
    'contract_end'::calendar_item_kind,
    c.id, c.machine_id, m.name, c.party, c.reference, c.end_date,
    case when c.end_date <= (now() at time zone 'Africa/Johannesburg')::date + coalesce(c.reminder_lead_days, 30)
           then 'due_soon'
         else 'ok' end
  from asset_contracts c
  left join machines m on m.id = c.machine_id
  where c.farm_id = p_farm
    and c.deleted_at is null and c.status = 'active'
    and (c.machine_id is null or m.deleted_at is null)
    and c.end_date is not null
    and c.end_date between p_from and p_to;
$$;

revoke execute on function app.finance_calendar_items(uuid, date, date) from public, anon;
grant execute on function app.finance_calendar_items(uuid, date, date) to authenticated, service_role;

-- The calendar itself: 20260921130000's five sources, unchanged, and the finance items.
create or replace function app.farm_calendar(p_farm uuid, p_from date, p_to date)
returns table (
  kind         calendar_item_kind,
  item_id      uuid,
  machine_id   uuid,
  machine_name text,
  title        text,
  detail       text,
  on_date      date,
  state        text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    'service_due'::calendar_item_kind,
    l.id, l.machine_id, m.name, l.task, null::text, l.next_due_date,
    case l.status::text when 'overdue' then 'overdue'
                        when 'due_soon' then 'due_soon'
                        else 'ok' end
  from service_plan_lines l
  join machines m on m.id = l.machine_id
  where l.farm_id = p_farm
    and l.deleted_at is null and m.deleted_at is null
    and m.status not in ('retired', 'sold')
    and l.next_due_date is not null
    and l.next_due_date between p_from and p_to

  union all

  select
    'job_card'::calendar_item_kind,
    j.id, j.machine_id, m.name,
    j.type::text, w.name, coalesce(j.date_in, j.created_at::date),
    case when j.status::text in ('open', 'in_progress', 'waiting_parts') then 'due_soon'
         else 'ok' end
  from job_cards j
  join machines m on m.id = j.machine_id
  left join workshops w on w.id = j.workshop_id
  where j.farm_id = p_farm
    and j.deleted_at is null and m.deleted_at is null
    and j.status::text <> 'approved'
    and coalesce(j.date_in, j.created_at::date) between p_from and p_to

  union all

  select
    'licence'::calendar_item_kind,
    c.id, c.machine_id, m.name, c.type::text, c.number, c.expiry_date,
    case when c.expiry_date < current_date then 'overdue'
         when c.expiry_date <= current_date + coalesce(c.reminder_lead_days, 30) then 'due_soon'
         else 'ok' end
  from licences c
  join machines m on m.id = c.machine_id
  where c.farm_id = p_farm
    and c.deleted_at is null and m.deleted_at is null
    and m.status not in ('retired', 'sold')
    and c.expiry_date between p_from and p_to

  union all

  select
    'driver_document'::calendar_item_kind,
    d.id, null::uuid, null::text,
    d.type::text,
    coalesce(nullif(btrim(d.person_name), ''), u.name, u.email),
    d.expiry_date,
    case when d.expiry_date < current_date then 'overdue'
         when d.expiry_date <= current_date + coalesce(d.reminder_lead_days, 30) then 'due_soon'
         else 'ok' end
  from driver_credentials d
  left join users u on u.id = d.user_id
  where d.farm_id = p_farm
    and d.deleted_at is null
    and d.expiry_date is not null
    and d.expiry_date between p_from and p_to

  union all

  select
    'work_request'::calendar_item_kind,
    r.id, r.machine_id, m.name, r.kind::text,
    coalesce(nullif(btrim(r.title), ''), r.status::text),
    r.created_at::date,
    case when r.status::text in ('requested', 'viewed', 'quoted', 'accepted',
                                 'in_progress', 'completed', 'invoiced')
         then 'due_soon' else 'ok' end
  from work_requests r
  join machines m on m.id = r.machine_id
  where r.farm_id = p_farm
    and r.deleted_at is null and m.deleted_at is null
    and r.created_at::date between p_from and p_to

  union all

  select * from app.finance_calendar_items(p_farm, p_from, p_to)

  order by 7, 5;
$$;
