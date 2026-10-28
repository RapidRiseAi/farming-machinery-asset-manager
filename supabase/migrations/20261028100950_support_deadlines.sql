-- 20261028100950_support_deadlines.sql
-- What is due on a support case, and the nightly chase (20260912160000) learning it.

-- == When the ball is in our court ==============================================
-- The deadline that matters now, or null when nothing is waiting on Rapid Rise:
--   * a dispute, refund or billing case keeps its own deadline while open (Paystack's clock);
--   * a customer case before its first answer: the same-day promise;
--   * after that, only when the customer has written since we last did: due_at, which their
--     reply set from the calendar;
--   * waiting on the customer, resolved or closed: nothing.
-- Mirrored by nextDue() in src/lib/support/sla.ts.
create or replace function app.support_next_due(
  p_kind          support_ticket_kind,
  p_status        support_ticket_status,
  p_due           timestamptz,
  p_first_due     timestamptz,
  p_first_at      timestamptz,
  p_last_customer timestamptz,
  p_last_staff    timestamptz
) returns timestamptz
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_status not in ('open', 'waiting') then null
    when p_kind not in ('help_request', 'privacy_request', 'export_request') then p_due
    when p_status = 'waiting' then null
    when p_first_at is null then coalesce(p_first_due, p_due)
    when p_last_customer is not null and p_last_customer > coalesce(p_last_staff, '-infinity'::timestamptz) then p_due
    else null
  end;
$$;

revoke execute on function app.support_next_due(support_ticket_kind, support_ticket_status, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;

-- == The chase ===================================================================
-- It used to chase every open case by due_at, test farms included, with dispute wording
-- ("Paystack settles it for us") for every kind. Now:
--   * the deadline is the one waiting on Rapid Rise (app.support_next_due): the same-day
--     first answer, or the customer's latest reply; a case waiting on the customer is not
--     chased;
--   * test cases are never chased;
--   * a customer case is chased with its own alert (support_request_due, no farm on the row,
--     case id only); disputes and billing cases keep the billing alert they had.
-- Same signatures and grants (none: reached only through public.cron_escalate_support_tickets).

create or replace function app.due_support_escalations(p_within interval default interval '12 hours')
returns table (
  id uuid, kind support_ticket_kind, subject text, farm_id uuid,
  due_at timestamptz, hours_left numeric, escalated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.kind, t.subject, t.farm_id, d.due,
         round(extract(epoch from (d.due - now())) / 3600.0, 1),
         t.escalated_at
    from public.support_tickets t
   cross join lateral (
     select app.support_next_due(t.kind, t.status, t.due_at, t.first_response_due_at,
                                 t.first_response_at, t.last_customer_at, t.last_staff_at) as due
   ) d
   where t.status in ('open', 'waiting')
     and not t.is_test
     and d.due is not null
     and d.due <= now() + greatest(p_within, interval '0')
     -- Chased at most once a day. A deadline that shouts every hour gets muted.
     and (t.escalated_at is null or t.escalated_at < now() - interval '20 hours')
   order by d.due;
$$;

create or replace function app.escalate_support_tickets(p_within interval default interval '12 hours')
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n integer := 0;
begin
  for r in select * from app.due_support_escalations(p_within) loop
    if r.kind in ('help_request', 'privacy_request', 'export_request') then
      perform app.notify_rr_support(r.id, 'support_request_due',
                                    jsonb_build_object('hours_left', r.hours_left));
    else
      -- Rapid Rise, and only Rapid Rise. For a dispute the farm may be the party that raised it.
      perform app.notify_rr_billing(
        r.farm_id,
        'support_ticket_due',
        jsonb_build_object(
          'ticket_id', r.id,
          'kind', r.kind::text,
          'subject', r.subject,
          'due_at', r.due_at,
          'hours_left', r.hours_left)
      );
    end if;
    update public.support_tickets set escalated_at = now(), updated_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
