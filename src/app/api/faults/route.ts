import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadFaultMedia } from "@/lib/fault-media";

export const dynamic = "force-dynamic";

const URGENCIES = ["can_work", "limping", "stopped"];
const REPORTERS = ["owner", "manager", "mechanic", "operator"];

/**
 * In-app fault report with optional photo + voice note. The fault row is written
 * through the authenticated (RLS-scoped) client; media is uploaded via the service
 * role into the machine's farm folder (attachments are validated to the user's farm).
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active || !REPORTERS.includes(profile.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const machineId = String(form.get("machine_id") ?? "");
  const description = String(form.get("description") ?? "").trim();
  const urgencyRaw = String(form.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = String(form.get("category") ?? "").trim() || null;
  if (!machineId || !description) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const supabase = await createClient();
  // RLS scopes this to the user's farm(s) — an unauthorised machine id returns null.
  const { data: machine } = await supabase.from("machines").select("id, farm_id").eq("id", machineId).is("deleted_at", null).maybeSingle();
  const m = machine as { id: string; farm_id: string } | null;
  if (!m) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: fault, error } = await supabase
    .from("faults")
    .insert({ farm_id: m.farm_id, machine_id: m.id, description, urgency, category, reported_by: profile.id, status: "open" })
    .select("id")
    .single();
  if (error || !fault) return NextResponse.json({ error: "insert_failed" }, { status: 500 });

  await uploadFaultMedia(createServiceClient(), form, m.farm_id, fault.id, profile.id);
  return NextResponse.json({ ok: true });
}
