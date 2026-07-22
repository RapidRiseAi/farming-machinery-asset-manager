import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadFaultMedia } from "@/lib/fault-media";

export const dynamic = "force-dynamic";

const URGENCIES = ["can_work", "limping", "stopped"];

/**
 * Anonymous fault report from the public QR page (Scope §4.5). The per-machine
 * token is the ONLY credential — this route runs as the service role and does all
 * DB/Storage work server-side, so the public page never touches the DB directly.
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const token = String(form.get("token") ?? "");
  const description = String(form.get("description") ?? "").trim();
  const urgencyRaw = String(form.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = String(form.get("category") ?? "").trim() || null;
  const reporter = String(form.get("name") ?? "").trim() || null;
  if (!token || !description) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const svc = createServiceClient();
  const { data: machine } = await svc
    .from("machines")
    .select("id, farm_id")
    .eq("public_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  const m = machine as { id: string; farm_id: string } | null;
  if (!m) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: fault, error } = await svc
    .from("faults")
    .insert({ farm_id: m.farm_id, machine_id: m.id, description, urgency, category, reporter_name: reporter, status: "open" })
    .select("id")
    .single();
  if (error || !fault) return NextResponse.json({ error: "insert_failed" }, { status: 500 });

  await uploadFaultMedia(svc, form, m.farm_id, fault.id, null);
  return NextResponse.json({ ok: true });
}
