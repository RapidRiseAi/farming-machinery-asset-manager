import { NextResponse } from "next/server";
import { getProfile, type Profile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadFaultMedia } from "@/lib/fault-media";
import { parseRandsToCents, exVatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

type Svc = ReturnType<typeof createServiceClient>;
type Fields = Record<string, string>;
type ApplyResult = { status: "applied" | "conflict"; entity: string; entity_id: string | null; superseded: unknown };

const MUTATIONS = ["log_reading", "report_fault", "add_job_line", "complete_job"] as const;
const SCOPES = ["app", "public"] as const;
const URGENCIES = ["can_work", "limping", "stopped"];
const READING_ROLES = ["owner", "manager", "mechanic"];
const REPORTER_ROLES = ["owner", "manager", "mechanic", "operator"];
const CREW_ROLES = ["owner", "manager", "mechanic", "workshop"];

type MutationType = (typeof MUTATIONS)[number];
type Scope = (typeof SCOPES)[number];

/** Replicates app.has_farm_access for a resolved profile (service role bypasses RLS). */
async function canAccessFarm(profile: Profile, farmId: string, svc: Svc): Promise<boolean> {
  if (profile.role === "rr_admin") return true;
  if (profile.farm_id && profile.farm_id === farmId) return true;
  if (profile.workshop_id) {
    const { data } = await svc
      .from("workshop_links")
      .select("farm_id")
      .eq("workshop_id", profile.workshop_id)
      .eq("farm_id", farmId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    if (data) return true;
  }
  return false;
}

async function machineByToken(svc: Svc, token: string) {
  const { data } = await svc
    .from("machines")
    .select("id, farm_id, meter_type")
    .eq("public_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  return data as { id: string; farm_id: string; meter_type: string } | null;
}

async function machineById(svc: Svc, id: string) {
  const { data } = await svc
    .from("machines")
    .select("id, farm_id, meter_type")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return data as { id: string; farm_id: string; meter_type: string } | null;
}

/** Fault reporter role → meter_source used when the reading rides along. */
function readingSource(scope: Scope): "qr" | "manual" {
  return scope === "public" ? "qr" : "manual";
}

// ── Per-type appliers. Each resolves tenancy itself, then applies via the service role.
// They throw `AccessError` for auth/permission problems (→ 4xx, dropped) and generic
// errors for transient failures (→ 5xx, retried).

class AccessError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

async function applyReading(
  svc: Svc,
  scope: Scope,
  fields: Fields,
  profile: Profile | null,
  clientTs: string,
): Promise<ApplyResult> {
  const readingNum = Number(String(fields.reading ?? "").trim());
  if (!Number.isFinite(readingNum) || readingNum < 0) throw new AccessError(400, "bad_reading");
  const readingDate = (fields.reading_date ?? "").trim() || new Date().toISOString().slice(0, 10);

  let machine: { id: string; farm_id: string } | null;
  let byUser: string | null;
  if (scope === "public") {
    machine = await machineByToken(svc, fields.token ?? "");
    byUser = null;
  } else {
    if (!profile || !READING_ROLES.includes(profile.role)) throw new AccessError(403, "forbidden");
    machine = await machineById(svc, fields.machine_id ?? "");
    if (machine && !(await canAccessFarm(profile, machine.farm_id, svc))) throw new AccessError(403, "forbidden");
    byUser = profile.id;
  }
  if (!machine) throw new AccessError(404, "machine_not_found");

  const { data, error } = await svc.rpc("sync_apply_reading", {
    p_farm: machine.farm_id,
    p_machine: machine.id,
    p_reading: readingNum,
    p_reading_date: readingDate,
    p_source: readingSource(scope),
    p_by_user: byUser,
    p_client_ts: clientTs,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as { status?: string; reading_id?: string; superseded?: unknown };
  return {
    status: r.status === "conflict" ? "conflict" : "applied",
    entity: "meter_readings",
    entity_id: r.reading_id ?? null,
    superseded: r.superseded ?? null,
  };
}

async function applyFault(
  svc: Svc,
  scope: Scope,
  fields: Fields,
  form: FormData,
  profile: Profile | null,
): Promise<ApplyResult> {
  const description = (fields.description ?? "").trim();
  if (!description) throw new AccessError(400, "missing_description");
  const urgencyRaw = fields.urgency ?? "can_work";
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = (fields.category ?? "").trim() || null;

  let machine: { id: string; farm_id: string } | null;
  let row: Record<string, unknown>;
  let byUser: string | null;
  if (scope === "public") {
    machine = await machineByToken(svc, fields.token ?? "");
    if (!machine) throw new AccessError(404, "machine_not_found");
    byUser = null;
    row = {
      farm_id: machine.farm_id,
      machine_id: machine.id,
      description,
      urgency,
      category,
      reporter_name: (fields.name ?? "").trim() || null,
      status: "open",
    };
  } else {
    if (!profile || !REPORTER_ROLES.includes(profile.role)) throw new AccessError(403, "forbidden");
    machine = await machineById(svc, fields.machine_id ?? "");
    if (!machine) throw new AccessError(404, "machine_not_found");
    if (!(await canAccessFarm(profile, machine.farm_id, svc))) throw new AccessError(403, "forbidden");
    byUser = profile.id;
    row = {
      farm_id: machine.farm_id,
      machine_id: machine.id,
      description,
      urgency,
      category,
      reported_by: profile.id,
      status: "open",
    };
  }

  const { data: fault, error } = await svc.from("faults").insert(row).select("id").single();
  if (error || !fault) throw new Error(error?.message ?? "insert_failed");
  await uploadFaultMedia(svc, form, machine.farm_id, fault.id as string, byUser);
  return { status: "applied", entity: "faults", entity_id: fault.id as string, superseded: null };
}

async function applyJobLine(svc: Svc, fields: Fields, profile: Profile | null): Promise<ApplyResult> {
  if (!profile || !CREW_ROLES.includes(profile.role)) throw new AccessError(403, "forbidden");
  const jobCardId = (fields.job_card_id ?? "").trim();
  if (!jobCardId) throw new AccessError(400, "missing_job_card");
  const { data: jc } = await svc
    .from("job_cards")
    .select("id, farm_id, vat_rate_bps, locked")
    .eq("id", jobCardId)
    .is("deleted_at", null)
    .maybeSingle();
  const card = jc as { id: string; farm_id: string; vat_rate_bps: number; locked: boolean } | null;
  if (!card) throw new AccessError(404, "job_card_not_found");
  if (!(await canAccessFarm(profile, card.farm_id, svc))) throw new AccessError(403, "forbidden");

  // The card locked (was approved) while this was queued offline: the line can't be
  // applied. Preserve it as a conflict record rather than silently dropping it.
  if (card.locked) {
    return { status: "conflict", entity: "job_card_lines", entity_id: null, superseded: fields };
  }

  const kindRaw = fields.kind ?? "part";
  const kind = ["part", "labour", "other"].includes(kindRaw) ? kindRaw : "part";
  const inclVat = (fields.incl_vat ?? "") === "1";
  let unitCents = kind === "labour" ? null : parseRandsToCents(fields.unit_cost ?? "");
  let rateCents = kind === "labour" ? parseRandsToCents(fields.rate ?? "") : null;
  if (inclVat) {
    const bps = card.vat_rate_bps ?? 1500;
    if (unitCents != null) unitCents = exVatCents(unitCents, bps);
    if (rateCents != null) rateCents = exVatCents(rateCents, bps);
  }
  const numOrNull = (v: string | undefined) => {
    const n = Number(String(v ?? "").trim());
    return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
  };

  const { data: line, error } = await svc
    .from("job_card_lines")
    .insert({
      farm_id: card.farm_id,
      job_card_id: card.id,
      kind,
      description: (fields.description ?? "").trim() || null,
      part_no: (fields.part_no ?? "").trim() || null,
      qty: kind === "part" ? numOrNull(fields.qty) : null,
      unit_cost_cents: unitCents,
      hours: kind === "labour" ? numOrNull(fields.hours) : null,
      rate_cents: rateCents,
    })
    .select("id")
    .single();
  if (error || !line) throw new Error(error?.message ?? "insert_failed");
  return { status: "applied", entity: "job_card_lines", entity_id: line.id as string, superseded: null };
}

async function applyCompleteJob(svc: Svc, fields: Fields, profile: Profile | null): Promise<ApplyResult> {
  if (!profile || !CREW_ROLES.includes(profile.role)) throw new AccessError(403, "forbidden");
  const jobCardId = (fields.id ?? fields.job_card_id ?? "").trim();
  if (!jobCardId) throw new AccessError(400, "missing_job_card");
  const { data: jc } = await svc
    .from("job_cards")
    .select("id, farm_id, status, locked, meter_reading")
    .eq("id", jobCardId)
    .is("deleted_at", null)
    .maybeSingle();
  const card = jc as { id: string; farm_id: string; status: string; locked: boolean; meter_reading: number | null } | null;
  if (!card) throw new AccessError(404, "job_card_not_found");
  if (!(await canAccessFarm(profile, card.farm_id, svc))) throw new AccessError(403, "forbidden");

  // Already completed/approved (or locked): the completion already happened — treat as a
  // no-op so the replay is idempotent.
  if (card.locked || card.status === "completed" || card.status === "approved") {
    return { status: "applied", entity: "job_cards", entity_id: card.id, superseded: null };
  }

  const meterRaw = String(fields.meter_reading ?? "").trim();
  const meter = meterRaw !== "" && Number.isFinite(Number(meterRaw)) ? Number(meterRaw) : card.meter_reading;
  const { error } = await svc
    .from("job_cards")
    .update({
      status: "completed",
      date_out: new Date().toISOString().slice(0, 10),
      ...(meter != null ? { meter_reading: meter } : {}),
    })
    .eq("id", card.id);
  if (error) throw new Error(error.message);
  return { status: "applied", entity: "job_cards", entity_id: card.id, superseded: null };
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const clientId = String(form.get("client_id") ?? "");
  const type = String(form.get("type") ?? "") as MutationType;
  const scopeRaw = String(form.get("scope") ?? "app");
  const scope: Scope = SCOPES.includes(scopeRaw as Scope) ? (scopeRaw as Scope) : "app";
  const clientTsRaw = String(form.get("client_ts") ?? "");
  const clientTs = clientTsRaw && !Number.isNaN(Date.parse(clientTsRaw)) ? clientTsRaw : new Date().toISOString();

  if (!clientId || !MUTATIONS.includes(type)) {
    return NextResponse.json({ error: "bad_mutation" }, { status: 400 });
  }
  let fields: Fields;
  try {
    fields = JSON.parse(String(form.get("payload") ?? "{}")) as Fields;
  } catch {
    return NextResponse.json({ error: "bad_payload" }, { status: 400 });
  }

  // App-scope mutations need a live session; public (QR) mutations are token-gated.
  const profile = scope === "app" ? await getProfile() : null;
  if (scope === "app" && (!profile || !profile.active)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (scope === "public" && (type === "add_job_line" || type === "complete_job")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const svc = createServiceClient();

  // Resolve the farm for the sync_log row (best-effort; the appliers re-check access).
  let farmId: string | null = null;
  try {
    if (scope === "public") {
      const m = await machineByToken(svc, fields.token ?? "");
      farmId = m?.farm_id ?? null;
    } else if (type === "add_job_line" || type === "complete_job") {
      const jcId = (fields.job_card_id ?? fields.id ?? "").trim();
      if (jcId) {
        const { data } = await svc.from("job_cards").select("farm_id").eq("id", jcId).maybeSingle();
        farmId = (data as { farm_id: string } | null)?.farm_id ?? null;
      }
    } else {
      const m = await machineById(svc, fields.machine_id ?? "");
      farmId = m?.farm_id ?? profile?.farm_id ?? null;
    }
  } catch {
    farmId = profile?.farm_id ?? null;
  }
  if (!farmId) farmId = profile?.farm_id ?? null;
  if (!farmId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // ── Idempotency claim. The unique client_id gate means a replay of an already-applied
  // mutation returns 'duplicate' without re-applying. ──
  const { error: claimErr } = await svc.from("sync_log").insert({
    farm_id: farmId,
    client_id: clientId,
    mutation: type,
    scope,
    status: "pending",
    client_ts: clientTs,
    by_user: profile?.id ?? null,
    payload: fields,
  });
  if (claimErr) {
    // 23505 unique_violation → already claimed/applied. Ack so the client drops it.
    if ((claimErr as { code?: string }).code === "23505") {
      return NextResponse.json({ status: "duplicate", client_id: clientId });
    }
    return NextResponse.json({ error: "claim_failed" }, { status: 500 });
  }

  try {
    let result: ApplyResult;
    if (type === "log_reading") result = await applyReading(svc, scope, fields, profile, clientTs);
    else if (type === "report_fault") result = await applyFault(svc, scope, fields, form, profile);
    else if (type === "add_job_line") result = await applyJobLine(svc, fields, profile);
    else result = await applyCompleteJob(svc, fields, profile);

    await svc
      .from("sync_log")
      .update({
        status: result.status,
        entity: result.entity,
        entity_id: result.entity_id,
        superseded: result.superseded ?? null,
        applied_at: new Date().toISOString(),
      })
      .eq("client_id", clientId);

    return NextResponse.json({ status: result.status, client_id: clientId, entity_id: result.entity_id });
  } catch (e) {
    // Release the claim so a retry can re-apply (transient) — except for permanent 4xx,
    // which we still release (the client drops it, nothing left half-applied).
    await svc.from("sync_log").delete().eq("client_id", clientId).eq("status", "pending");
    if (e instanceof AccessError) {
      return NextResponse.json({ error: e.message }, { status: e.code });
    }
    return NextResponse.json({ error: "apply_failed" }, { status: 500 });
  }
}
