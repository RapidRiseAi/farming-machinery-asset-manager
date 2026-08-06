-- 0391_see_who_is_asking.sql
-- You cannot approve a contractor you are not allowed to see.
--
-- Found by driving the built app: a pending connection request rendered on the farm's
-- Partners screen as an empty row with no name, no trade and no contact details, and the
-- approve/decline controls never appeared at all.
--
-- The cause is in 0101. `workshops_sel` lets a farm read a workshop only through a link
-- whose status is ACTIVE:
--
--     id in (select wl.workshop_id from workshop_links wl
--             where app.has_farm_access(wl.farm_id) and wl.status = 'active' …)
--
-- which was right when the only way a link existed was that the farm made it. F15 adds
-- the other direction — a contractor asks first (0390 `wl_ins_request`, and only ever as
-- 'pending') — and that left the farm looking at a request from nobody.
--
-- So: widen the same clause to 'pending' as well. What this discloses is exactly the
-- business card a contractor is holding out when they ask to be connected — trading
-- name, trade, area, phone, email — to the one farm they asked. It grants nothing else:
-- `app.has_farm_access` still counts only active links, so the contractor still sees
-- none of the farm's data until the farm says yes, and the farm still sees none of the
-- contractor's clients or documents ever.

drop policy workshops_sel on workshops;

create policy workshops_sel on workshops for select to authenticated
  using (
    app.is_rr_admin()
    or id = app.user_workshop_id()
    or id in (
      select wl.workshop_id from workshop_links wl
      where app.has_farm_access(wl.farm_id)
        -- 'pending' is here so a farm can read the card of a contractor asking to
        -- connect. It is a request, not a grant: has_farm_access is unchanged.
        and wl.status in ('active', 'pending')
        and wl.deleted_at is null
    )
  );
