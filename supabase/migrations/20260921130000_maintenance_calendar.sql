-- 20260921130000_maintenance_calendar.sql
-- What is due and what is booked, on a calendar, so a farm can plan around harvest.
--
-- Everything on this calendar already exists. Services carry a `next_due_date`, job cards
-- carry a `date_in`, licences and driver documents carry an `expiry_date`, and a farm can
-- see all of it, one screen at a time, in five different lists. What nobody can see is the
-- WEEK: that the annual service, the roadworthy and the PrDP all land in the fortnight the
-- wheat has to come off.
--
-- ONE FUNCTION, SECURITY INVOKER, FIVE SOURCES
-- =============================================================================
-- Each source keeps its own RLS. An operator calling this gets services on their own
-- machines and no driver documents at all, not because this function filters them out but
-- because `driver_credentials` refuses them, and a linked workshop gets its own job cards
-- and nothing else. Adding a source here cannot widen what anybody can see.
--
-- NO MONEY ON IT
-- =============================================================================
-- Deliberately. A job card's total is behind `app.can_view_farm_costs`, and a calendar
-- that carried amounts would be a second door onto the figure that migration closed. What
-- a planner needs is WHEN and WHICH MACHINE, and that is all this returns.

create type calendar_item_kind as enum (
  'service_due',      -- a service plan line with a date
  'job_card',         -- work booked in or being done
  'licence',          -- the disc on the windscreen, and its relatives
  'driver_document',  -- the card in the driver's pocket
  'work_request'      -- something asked of a contractor
);

-- == Everything dated, between two days =====================================
create or replace function app.farm_calendar(p_farm uuid, p_from date, p_to date)
returns table (
  kind         calendar_item_kind,
  item_id      uuid,
  machine_id   uuid,
  machine_name text,
  title        text,
  detail       text,
  on_date      date,
  -- `overdue` | `due_soon` | `ok`, in the vocabulary the rest of the product already uses,
  -- so one colour scale covers the whole calendar.
  state        text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- Services due. The `status` column is maintained by the nightly recompute, so this
  -- reports what the rest of the product already believes rather than recomputing it here
  -- and risking a calendar that disagrees with the machine page.
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

  -- Work booked in or under way. `approved` is finished and off the plan; anything else
  -- still occupies a day and a workshop.
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

  -- The vehicle's own documents.
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

  -- The driver's. No machine, so the machine columns are null and the screen shows the
  -- person instead. RLS on driver_credentials is narrower than the rest of this function:
  -- an operator sees only their own row, and a linked workshop sees none.
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

  -- What has been asked of a contractor and not yet closed.
  select
    'work_request'::calendar_item_kind,
    -- The title the farm typed, when there is one. Falling back to the status keeps the
    -- row readable rather than leaving a blank line on a planning screen.
    r.id, r.machine_id, m.name, r.kind::text,
    coalesce(nullif(btrim(r.title), ''), r.status::text),
    r.created_at::date,
    -- The real vocabulary of work_request_status. "requested" through "invoiced" is
    -- still somebody waiting on somebody; "closed" is done.
    case when r.status::text in ('requested', 'viewed', 'quoted', 'accepted',
                                 'in_progress', 'completed', 'invoiced')
         then 'due_soon' else 'ok' end
  from work_requests r
  join machines m on m.id = r.machine_id
  where r.farm_id = p_farm
    and r.deleted_at is null and m.deleted_at is null
    and r.created_at::date between p_from and p_to

  order by 7, 5;
$$;

grant execute on function app.farm_calendar(uuid, date, date) to authenticated, service_role;

-- PostgREST reaches `public` only.
create or replace function public.farm_calendar(p_farm uuid, p_from date, p_to date)
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
set search_path = public, app, pg_temp
as $$
  select * from app.farm_calendar(p_farm, p_from, p_to);
$$;

revoke execute on function public.farm_calendar(uuid, date, date) from public, anon;
grant  execute on function public.farm_calendar(uuid, date, date) to authenticated, service_role;

comment on function public.farm_calendar(uuid, date, date) is
  'Everything dated on a farm between two days: services due, work booked, vehicle '
  'documents, driver documents and contractor requests. SECURITY INVOKER, so each source '
  'keeps its own RLS. Carries no money.';
