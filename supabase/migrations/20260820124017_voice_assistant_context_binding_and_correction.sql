-- Bind confirmation to the farm selected by the server-side request context, and
-- provide one atomic server-only transition for voice transcripts the user corrects.

-- Keep the original, fully validated implementation as a private implementation
-- detail. The public RPC now requires the selected farm explicitly, so a proposal
-- prepared on Farm A cannot be confirmed after the UI has switched to Farm B.
alter function public.apply_assistant_proposal(uuid, text)
  rename to apply_assistant_proposal_internal;

revoke execute on function public.apply_assistant_proposal_internal(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.apply_assistant_proposal(
  p_proposal_id uuid,
  p_action text,
  p_expected_farm uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_proposal_farm uuid;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_proposal_id is null or p_action is null or p_expected_farm is null
     or p_action not in ('confirm', 'reject') then
    return jsonb_build_object(
      'ok', false, 'code', 'bad_request',
      'message', 'A proposal ID, selected farm, and confirm/reject action are required.'
    );
  end if;

  -- The row lock remains held while the internal implementation runs. Proposal scope
  -- is immutable, but locking also serializes this context check with confirmation,
  -- rejection, expiry and transcript-supersession transitions.
  select i.farm_id into v_proposal_farm
    from public.ai_interactions i
   where i.id = p_proposal_id
     and i.user_id = v_user
     and i.deleted_at is null
   for update;
  if not found then
    raise exception 'Proposal not found.' using errcode = '42501';
  end if;

  if v_proposal_farm is distinct from p_expected_farm then
    return jsonb_build_object(
      'ok', false, 'code', 'farm_context_changed',
      'message', 'The selected farm changed after this proposal was prepared.'
    );
  end if;

  return public.apply_assistant_proposal_internal(p_proposal_id, p_action);
end $$;

revoke execute on function public.apply_assistant_proposal(uuid, text, uuid)
  from public, anon, service_role;
grant execute on function public.apply_assistant_proposal(uuid, text, uuid)
  to authenticated;

-- A corrected transcript is a new evidentiary capture, never an edit of the original.
-- This trusted-server RPC atomically makes every still-actionable proposal tied to the
-- old capture non-actionable, then cancels the old non-terminal capture. A concurrent
-- confirmation and this transition serialize on the interaction row: whichever locks
-- first wins, so a proposal can never be both applied and later presented as pending.
create or replace function public.supersede_assistant_voice_capture(
  p_capture_ids uuid[],
  p_farm uuid,
  p_user uuid
) returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_superseded integer := 0;
begin
  if coalesce(cardinality(p_capture_ids), 0) not between 1 and 5
     or array_position(p_capture_ids, null) is not null
     or p_farm is null or p_user is null then
    raise exception 'One to five capture IDs, a farm, and a user are required.'
      using errcode = '22023';
  end if;

  update public.ai_interactions
     set result_status = 'failed',
         confirmation_status = 'failed',
         response_text = 'Superseded by a corrected transcript.',
         error_code = 'superseded',
         proposal_expires_at = least(coalesce(proposal_expires_at, now()), now()),
         completed_at = now()
   where voice_capture_id = any(p_capture_ids)
     and farm_id = p_farm
     and user_id = p_user
     and deleted_at is null
     and result_status = 'proposed'
     and confirmation_status in ('not_required', 'processing', 'pending');
  get diagnostics v_superseded = row_count;

  update public.voice_captures
     set status = 'cancelled',
         error_code = 'superseded'
   where id = any(p_capture_ids)
     and farm_id = p_farm
     and user_id = p_user
     and deleted_at is null
     and status in (
       'captured', 'queued', 'transcribing', 'transcribed',
       'parsed', 'awaiting_confirmation'
     );

  return v_superseded;
end $$;

revoke execute on function public.supersede_assistant_voice_capture(uuid[], uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.supersede_assistant_voice_capture(uuid[], uuid, uuid)
  to service_role;

-- Make the new overloaded RPC visible promptly to PostgREST during the coordinated
-- application-first rollout. The route retains a scoped fallback until this reload lands.
notify pgrst, 'reload schema';
