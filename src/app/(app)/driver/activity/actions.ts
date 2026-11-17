"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile, requireUsableFarm } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { manualDriveArgs, type ManualDriveDraft, type ManualDriveContext } from "@/lib/manual-driving";
import { captureError } from "@/lib/observability";

export async function saveManualActivity(draft:ManualDriveDraft,context:ManualDriveContext):Promise<{ok:boolean;reason?:"invalid"|"changed"|"forbidden"|"backwards"|"stale"}> {
  await requireProfile();
  // Revalidate at the boundary; the database independently checks current membership and plan.
  let args:ReturnType<typeof manualDriveArgs>;
  try {args=manualDriveArgs(draft,context);}catch{return {ok:false,reason:"invalid"};}
  if(!args)return {ok:false,reason:"invalid"};
  const db=await createClient();
  const {error}=await db.rpc("record_manual_driving_event",args);
  if(error){
    if(error.code==="42501")return {ok:false,reason:"forbidden"};
    if(error.message==="driving-request-changed")return {ok:false,reason:"changed"};
    if(error.message==="driving-km-backwards")return {ok:false,reason:"backwards"};
    if(error.message==="driving-plan-changed")return {ok:false,reason:"stale"};
    captureError(new Error("Manual driving update refused"),{where:"driving:manual",extra:{code:error.code??null}});
    return {ok:false,reason:"invalid"};
  }
  revalidatePath("/driver/activity");
  return {ok:true};
}

export async function recordActivity(form: FormData) {
  const profile = await requireProfile();
  const db = await createClient();
  const farm = String(form.get("farm") ?? "");
  // record_driving_event refuses a farm whose stored status is suspended, but not one
  // that is pending or closed; the gate answers for all three.
  await requireUsableFarm(isUuid(farm) ? farm : null, profile);
  const raw = String(form.get("at") ?? "");
  // Explicit SAST for manager-entered times; server/device timezone never changes the date.
  const at = raw ? new Date(`${raw}:00+02:00`) : new Date();
  if (!Number.isFinite(at.getTime()))
    redirect("/driver/activity?error=driving_invalid");
  const coordinate = (key: string) =>
    form.get(key) ? Number(form.get(key)) : null;
  const { error } = await db.rpc("record_driving_event", {
    p_farm: farm,
    p_machine: String(form.get("machine") ?? ""),
    p_driver: String(form.get("driver") || profile.id),
    p_kind: String(form.get("kind") ?? ""),
    p_at: at.toISOString(),
    p_location: String(form.get("location") ?? ""),
    p_notes: String(form.get("notes") ?? ""),
    p_lat: coordinate("lat"),
    p_lng: coordinate("lng"),
    p_session: String(form.get("session") ?? "") || null,
  });
  revalidatePath("/driver/activity");
  redirect(
    `/driver/activity?farm=${encodeURIComponent(farm)}&${error ? "error=driving_invalid" : "saved=1"}`,
  );
}
