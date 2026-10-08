-- Diesel by voice: "I put 80 litres in the bakkie" becomes a confirmed fuel draw.
--
-- The assistant could report faults, save readings and save completed services. A fuel
-- draw, the most common thing a farm records, had to be typed on the Fuel page. This adds
-- it as the fourth confirmed command, through the same proposal the other three use: the
-- assistant prepares it, the person sees the card, and only their tap applies it here.
--
-- == The proposal shape ======================================================
-- Every draft so far has exactly eleven keys, and this function refuses anything else.
-- A draw needs two more: litres and the tank. A draft now has eleven keys, or thirteen
-- with both of those, and only a log_fuel draft may give them a value. The eleven-key
-- form stays valid, so the build that is live while this migration is applied keeps
-- confirming its proposals.
--
-- == The write ===============================================================
-- public.record_fuel_issue, the writer the Fuel page uses. It re-checks the person's role
-- (an operator may draw), the farm's plan (fuel is Professional and up), that the tank and
-- machine are this farm's and visible to them, and the meter type, and it writes the
-- driver's usage log in the same transaction. The cost is left empty, exactly as a draw
-- typed on the Fuel page with no cost is.
--
-- Recreated from 20260813200621's body (renamed _internal by 20260820124017); everything
-- outside the marked changes is unchanged. CREATE OR REPLACE keeps its grants: nobody but
-- the owner may call it, the public wrapper apply_assistant_proposal(uuid, text, uuid)
-- does.

create or replace function public.apply_assistant_proposal_internal(
  p_proposal_id uuid,
  p_action text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_interaction public.ai_interactions%rowtype;
  v_role user_role;
  v_args jsonb;
  v_intent text;
  v_machine uuid;
  v_confidence numeric;
  v_reading numeric;
  v_reading_date date;
  v_service_date date;
  v_linked_id uuid;
  v_linked_type text;
  v_message text;
  v_href text;
  v_capture_status text;
  v_error_code text;
  v_litres numeric;
  v_tank uuid;
  v_key_count integer;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_proposal_id is null or p_action is null
     or p_action not in ('confirm', 'reject') then
    return jsonb_build_object(
      'ok', false, 'code', 'bad_request',
      'message', 'A proposal ID and confirm/reject action are required.'
    );
  end if;

  -- A generic denial prevents an authenticated caller from probing another person's
  -- private proposal IDs. The lock serializes confirm/reject and makes retries exact.
  select * into v_interaction
    from public.ai_interactions i
   where i.id = p_proposal_id
     and i.user_id = v_user
     and i.deleted_at is null
   for update;
  if not found then
    raise exception 'Proposal not found.' using errcode = '42501';
  end if;

  -- Terminal retries are idempotent. Return the stored record/result without checking
  -- the requested action again and without performing another operational write.
  if v_interaction.result_status = 'applied'
     and v_interaction.confirmation_status = 'confirmed' then
    v_href := case v_interaction.linked_record_type
      when 'fault' then '/faults'
      when 'meter_reading' then
        case when jsonb_typeof(v_interaction.tool_args -> 'machineId') = 'string'
             then '/machines/' || (v_interaction.tool_args ->> 'machineId')
             else '/assistant' end
      when 'job_card' then '/jobcards/' || v_interaction.linked_record_id::text
      when 'fuel_issue' then '/fuel'
      else '/assistant'
    end;
    return jsonb_build_object(
      'ok', true, 'action', 'confirm', 'status', 'applied',
      'message', coalesce(v_interaction.response_text, 'The change was already saved.'),
      'linkedRecordType', v_interaction.linked_record_type,
      'linkedRecordId', v_interaction.linked_record_id,
      'href', v_href, 'replayed', true
    );
  elsif v_interaction.result_status = 'rejected'
        and v_interaction.confirmation_status = 'rejected' then
    return jsonb_build_object(
      'ok', true, 'action', 'reject', 'status', 'rejected',
      'message', coalesce(v_interaction.response_text, 'Nothing was saved.'),
      'linkedRecordType', 'none', 'linkedRecordId', v_interaction.id,
      'href', '/assistant', 'replayed', true
    );
  elsif v_interaction.result_status = 'failed'
        or v_interaction.confirmation_status = 'failed' then
    return jsonb_build_object(
      'ok', false, 'code', coalesce(v_interaction.error_code, 'proposal_failed'),
      'message', coalesce(v_interaction.response_text, 'This proposal previously failed.'),
      'replayed', true
    );
  end if;

  if v_interaction.result_status <> 'proposed'
     or v_interaction.confirmation_status <> 'pending' then
    return jsonb_build_object(
      'ok', false, 'code', 'proposal_unavailable',
      'message', 'This proposal is not pending.'
    );
  end if;
  if v_interaction.proposal_expires_at is null
     or v_interaction.proposal_expires_at <= now() then
    update public.ai_interactions
       set result_status = 'failed',
           confirmation_status = 'failed',
           response_text = 'This proposal expired before it was applied.',
           error_code = 'proposal_expired',
           completed_at = now()
     where id = v_interaction.id;
    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'failed', error_code = 'proposal_expired'
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;
    return jsonb_build_object(
      'ok', false, 'code', 'proposal_expired',
      'message', 'This proposal has expired. Please start again.'
    );
  end if;

  -- Stabilise account, membership and plan authorization until this transaction ends.
  -- FOR UPDATE blocks the non-key UPDATEs used to deactivate an account/membership,
  -- change a selected-farm role, or downgrade the farm plan while confirmation runs.
  perform 1 from public.users u
   where u.id = v_user and u.active and u.deleted_at is null
   for update;
  if not found then
    raise exception 'Active account required.' using errcode = '42501';
  end if;
  perform 1 from public.user_farm_memberships m
   where m.user_id = v_user
     and m.farm_id = v_interaction.farm_id
     and m.active
     and m.deleted_at is null
   for update;
  perform 1 from public.farms f
   where f.id = v_interaction.farm_id and f.deleted_at is null
   for update;
  if not found then
    raise exception 'Farm not found.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(v_user, v_interaction.farm_id);
  if v_role is null or not app.has_farm_access(v_interaction.farm_id) then
    return jsonb_build_object(
      'ok', false, 'code', 'forbidden',
      'message', 'This farm is no longer available to your account.'
    );
  end if;
  if v_role <> 'rr_admin'
     and not app.has_entitlement(v_interaction.farm_id, 'voice_ai') then
    return jsonb_build_object(
      'ok', false, 'code', 'feature_unavailable',
      'message', 'Voice assistant access is no longer enabled for this farm.'
    );
  end if;

  if v_interaction.voice_capture_id is not null then
    select c.status into v_capture_status
      from public.voice_captures c
     where c.id = v_interaction.voice_capture_id
       and c.farm_id = v_interaction.farm_id
       and c.user_id = v_user
       and c.deleted_at is null
     for update;
    if not found or v_capture_status <> 'awaiting_confirmation' then
      return jsonb_build_object(
        'ok', false, 'code', 'invalid_capture',
        'message', 'The linked voice capture is not awaiting confirmation.'
      );
    end if;
  end if;

  if p_action = 'reject' then
    v_message := case v_interaction.locale
      when 'af-ZA' then 'Niks is gestoor nie.'
      else 'Nothing was saved.'
    end;

    update public.ai_interactions
       set result_status = 'rejected',
           confirmation_status = 'rejected',
           response_text = v_message,
           linked_record_type = null,
           linked_record_id = null,
           error_code = null,
           completed_at = now()
     where id = v_interaction.id;

    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'cancelled'
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;

    return jsonb_build_object(
      'ok', true, 'action', 'reject', 'status', 'rejected',
      'message', v_message, 'linkedRecordType', 'none',
      'linkedRecordId', v_interaction.id, 'href', '/assistant',
      'replayed', false
    );
  end if;

  -- Strict server-held proposal schema. jsonb has unique object keys, so exactly the
  -- eleven known keys plus no unknown key proves presence and excludes smuggled data.
  begin
    v_args := v_interaction.tool_args;
    if jsonb_typeof(v_args) <> 'object' then
      raise exception 'The proposal payload must be an object.' using errcode = '22023';
    end if;
    -- Eleven keys, or thirteen with a diesel draw's litres and tank (2026-10-09). The
    -- build before that writes eleven, and keeps working while the release goes out.
    v_key_count := (select count(*) from jsonb_object_keys(v_args));
    if v_key_count not in (11, 13)
       or exists (
         select 1 from jsonb_object_keys(v_args) as k(key)
          where k.key <> all (array[
            'intent','machineQuery','machineId','description','category','urgency',
            'reading','readingDate','serviceDate','workPerformed','confidence',
            'litres','tankId'
          ])
       )
       or (v_key_count = 13 and not (v_args ? 'litres' and v_args ? 'tankId')) then
      raise exception 'The proposal payload has an invalid shape.' using errcode = '22023';
    end if;

    if coalesce(jsonb_typeof(v_args -> 'intent'), 'missing') <> 'string'
       or coalesce(jsonb_typeof(v_args -> 'machineId'), 'missing') <> 'string'
       or coalesce(jsonb_typeof(v_args -> 'confidence'), 'missing') <> 'number'
       or coalesce(jsonb_typeof(v_args -> 'machineQuery'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'description'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'category'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'urgency'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'reading'), 'missing') not in ('number','null')
       or coalesce(jsonb_typeof(v_args -> 'readingDate'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'serviceDate'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'workPerformed'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'litres'), 'null') not in ('number','null')
       or coalesce(jsonb_typeof(v_args -> 'tankId'), 'null') not in ('string','null')
       or char_length(coalesce(v_args ->> 'tankId', '')) not in (0, 36)
       or char_length(coalesce(v_args ->> 'litres', '')) > 32
       or char_length(coalesce(v_args ->> 'machineQuery', '')) > 8000
       or char_length(coalesce(v_args ->> 'description', '')) > 2000
       or char_length(coalesce(v_args ->> 'category', '')) > 80
       or char_length(coalesce(v_args ->> 'urgency', '')) > 20
       or char_length(coalesce(v_args ->> 'reading', '')) > 32
       or char_length(coalesce(v_args ->> 'readingDate', '')) > 10
       or char_length(coalesce(v_args ->> 'serviceDate', '')) > 10
       or char_length(coalesce(v_args ->> 'workPerformed', '')) > 2000
       or char_length(v_args ->> 'machineId') <> 36
       or char_length(v_args ->> 'confidence') > 32 then
      raise exception 'The proposal payload contains invalid values.' using errcode = '22023';
    end if;

    v_confidence := (v_args ->> 'confidence')::numeric;
    if v_confidence is null or v_confidence not between 0 and 1
       or (v_args ->> 'machineId') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'The proposal confidence or machine ID is invalid.' using errcode = '22023';
    end if;

    v_intent := v_args ->> 'intent';
    v_machine := (v_args ->> 'machineId')::uuid;
    if v_intent is null or v_intent not in ('report_fault','log_reading','log_service','log_fuel')
       or v_interaction.intent is distinct from v_intent
       or v_interaction.tool_name is distinct from v_intent then
      raise exception 'The proposal intent is invalid or inconsistent.' using errcode = '22023';
    end if;
    -- Litres and a tank belong to a diesel draw and nothing else.
    if v_intent <> 'log_fuel'
       and (coalesce(jsonb_typeof(v_args -> 'litres'), 'null') <> 'null'
         or coalesce(jsonb_typeof(v_args -> 'tankId'), 'null') <> 'null') then
      raise exception 'The proposal carries fuel fields for another kind of record.' using errcode = '22023';
    end if;
    if v_intent in ('log_reading','log_service')
       and v_role not in ('rr_admin','owner','manager','mechanic') then
      raise exception 'This farm role cannot record readings or completed services.'
        using errcode = '42501';
    end if;

    -- Stabilise visibility/assignment and meter state through the command. FOR UPDATE
    -- also prevents two concurrent reading/service proposals validating stale values.
    perform 1 from public.machines m
     where m.id = v_machine
       and m.farm_id = v_interaction.farm_id
       and m.deleted_at is null
       and app.row_visible_to_role(v_interaction.farm_id, v_machine)
     for update;
    if not found then
      raise exception 'The selected machine is no longer visible to this person.'
        using errcode = '42501';
    end if;

    if v_intent = 'report_fault' then
      if jsonb_typeof(v_args -> 'description') <> 'string'
       or nullif(btrim(v_args ->> 'description'), '') is null
       or jsonb_typeof(v_args -> 'urgency') <> 'string'
       or (v_args ->> 'urgency') not in ('can_work','limping','stopped')
       or jsonb_typeof(v_args -> 'category') not in ('string','null')
       or jsonb_typeof(v_args -> 'reading') <> 'null'
       or jsonb_typeof(v_args -> 'readingDate') <> 'null'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'null'
       or jsonb_typeof(v_args -> 'workPerformed') <> 'null' then
      raise exception 'The fault proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;

      v_linked_id := public.record_fault(
      v_interaction.farm_id,
      v_machine,
      v_args ->> 'description',
      (v_args ->> 'urgency')::fault_urgency,
      v_args ->> 'category'
    );
      v_linked_type := 'fault';
      v_href := '/faults';
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die fout is aangemeld.'
        else 'The fault was reported.'
      end;
    elsif v_intent = 'log_reading' then
      if jsonb_typeof(v_args -> 'reading') <> 'number'
       or jsonb_typeof(v_args -> 'readingDate') <> 'string'
       or (v_args ->> 'readingDate') !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(v_args -> 'description') <> 'null'
       or jsonb_typeof(v_args -> 'category') <> 'null'
       or jsonb_typeof(v_args -> 'urgency') <> 'null'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'null'
       or jsonb_typeof(v_args -> 'workPerformed') <> 'null' then
      raise exception 'The reading proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;
      begin
        v_reading := (v_args ->> 'reading')::numeric;
        v_reading_date := (v_args ->> 'readingDate')::date;
      exception when others then
        raise exception 'The reading value or date is invalid.' using errcode = '22023';
      end;
      if v_reading < 0 or v_reading > 99999999999.9
         or to_char(v_reading_date, 'YYYY-MM-DD') <> (v_args ->> 'readingDate')
         or v_reading_date > current_date then
        raise exception 'The reading date is invalid or in the future.' using errcode = '22023';
      end if;

      v_linked_id := public.record_meter_reading(
        v_interaction.farm_id, v_machine, v_reading, v_reading_date, null
      );
      v_linked_type := 'meter_reading';
      v_href := '/machines/' || v_machine::text;
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die lesing is aangeteken.'
        else 'The reading was saved.'
      end;
    elsif v_intent = 'log_service' then
      if jsonb_typeof(v_args -> 'reading') <> 'number'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'string'
       or (v_args ->> 'serviceDate') !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(v_args -> 'workPerformed') not in ('string','null')
       or jsonb_typeof(v_args -> 'description') <> 'null'
       or jsonb_typeof(v_args -> 'category') <> 'null'
       or jsonb_typeof(v_args -> 'urgency') <> 'null'
       or jsonb_typeof(v_args -> 'readingDate') <> 'null' then
      raise exception 'The service proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;
      begin
        v_reading := (v_args ->> 'reading')::numeric;
        v_service_date := (v_args ->> 'serviceDate')::date;
      exception when others then
        raise exception 'The service reading or date is invalid.' using errcode = '22023';
      end;
      if v_reading < 0 or v_reading > 99999999999.9
         or to_char(v_service_date, 'YYYY-MM-DD') <> (v_args ->> 'serviceDate')
         or v_service_date > current_date then
        raise exception 'The service date is invalid or in the future.' using errcode = '22023';
      end if;

      v_linked_id := public.record_completed_service(
        v_interaction.farm_id,
        v_machine,
        v_reading,
        v_service_date,
        v_args ->> 'workPerformed'
      );
      v_linked_type := 'job_card';
      v_href := '/jobcards/' || v_linked_id::text;
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die voltooide diens is aangeteken.'
        else 'The completed service was saved.'
      end;
    else
      -- A diesel draw: litres from a tank into this machine, with the meter reading when
      -- one was said, dated the day that was said or today. record_fuel_issue is the same
      -- writer the Fuel page uses: it checks the role, the plan, the tank and the machine
      -- again, and writes the driver's usage log in the same transaction.
      -- coalesce(..., 'missing'): a key that is absent must fail here, not slip through
      -- as NULL (a NULL inside an OR leaves the whole test NULL, and IF NULL is false).
      if v_key_count <> 13
       or coalesce(jsonb_typeof(v_args -> 'litres'), 'missing') <> 'number'
       or coalesce(jsonb_typeof(v_args -> 'tankId'), 'missing') <> 'string'
       or coalesce((v_args ->> 'tankId') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true)
       or coalesce(jsonb_typeof(v_args -> 'reading'), 'missing') not in ('number','null')
       or coalesce(jsonb_typeof(v_args -> 'readingDate'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'description'), 'missing') <> 'null'
       or coalesce(jsonb_typeof(v_args -> 'category'), 'missing') <> 'null'
       or coalesce(jsonb_typeof(v_args -> 'urgency'), 'missing') <> 'null'
       or coalesce(jsonb_typeof(v_args -> 'serviceDate'), 'missing') <> 'null'
       or coalesce(jsonb_typeof(v_args -> 'workPerformed'), 'missing') <> 'null' then
        raise exception 'The fuel proposal is incomplete or contains unrelated fields.'
          using errcode = '22023';
      end if;
      begin
        v_litres := (v_args ->> 'litres')::numeric;
        v_tank := (v_args ->> 'tankId')::uuid;
        v_reading := case when jsonb_typeof(v_args -> 'reading') = 'number'
                          then (v_args ->> 'reading')::numeric end;
        v_reading_date := coalesce((v_args ->> 'readingDate')::date, current_date);
      exception when others then
        raise exception 'The fuel draw values are invalid.' using errcode = '22023';
      end;
      if v_litres is null or v_tank is null or v_reading_date is null
         or v_litres <= 0 or v_litres > 100000
         or (v_args ->> 'readingDate' is not null
             and to_char(v_reading_date, 'YYYY-MM-DD') <> (v_args ->> 'readingDate'))
         or v_reading_date > current_date then
        raise exception 'The fuel draw litres or date are invalid.' using errcode = '22023';
      end if;

      v_linked_id := public.record_fuel_issue(
        v_interaction.farm_id, v_tank, v_machine, v_reading_date, v_litres, v_reading,
        null, null, null
      );
      v_linked_type := 'fuel_issue';
      v_href := '/fuel';
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die dieseltrekking is aangeteken.'
        else 'The diesel draw was saved.'
      end;
    end if;
  exception when others then
    v_error_code := case sqlstate
      when '42501' then 'forbidden'
      when '22023' then 'invalid_proposal'
      else 'command_failed'
    end;
    v_message := case v_error_code
      when 'forbidden' then 'FleetWise permissions no longer allow this proposal.'
      when 'invalid_proposal' then 'The proposal details are no longer valid.'
      else 'FleetWise could not save the confirmed change.'
    end;

    update public.ai_interactions
       set result_status = 'failed',
           confirmation_status = 'failed',
           response_text = v_message,
           error_code = v_error_code,
           completed_at = now()
     where id = v_interaction.id;
    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'failed', error_code = v_error_code
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;
    return jsonb_build_object(
      'ok', false, 'code', v_error_code, 'message', v_message,
      'replayed', false
    );
  end;

  update public.ai_interactions
     set result_status = 'applied',
         confirmation_status = 'confirmed',
         response_text = v_message,
         linked_record_type = v_linked_type,
         linked_record_id = v_linked_id,
         error_code = null,
         completed_at = now()
   where id = v_interaction.id;

  if v_interaction.voice_capture_id is not null then
    update public.voice_captures
       set status = 'applied',
           machine_id = v_machine,
           confirmed_at = now(),
           applied_at = now()
     where id = v_interaction.voice_capture_id
       and farm_id = v_interaction.farm_id
       and user_id = v_user;
  end if;

  return jsonb_build_object(
    'ok', true, 'action', 'confirm', 'status', 'applied',
    'message', v_message, 'linkedRecordType', v_linked_type,
    'linkedRecordId', v_linked_id, 'href', v_href,
    'replayed', false
  );
end $$;
