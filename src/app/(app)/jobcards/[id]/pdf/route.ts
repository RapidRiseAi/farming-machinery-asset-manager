import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";

export const dynamic = "force-dynamic";

type JC = {
  id: string; farm_id: string; machine_id: string; type: string; status: string;
  date_in: string | null; date_out: string | null; meter_reading: number | null;
  reported_problem: string | null; diagnosis: string | null; work_performed: string | null; recommendations: string | null;
  parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number;
  locked: boolean; approved_at: string | null;
};
type Line = { kind: string; description: string | null; part_no: string | null; qty: number | null; unit_cost_cents: number | null; hours: number | null; rate_cents: number | null; total_cents: number };

const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase.from("job_cards").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  const jc = data as JC | null;
  if (!jc) return new Response("Not found", { status: 404 });

  const [{ data: mData }, { data: lData }, { data: farmData }] = await Promise.all([
    supabase.from("machines").select("name, make, model, reg_no, meter_type").eq("id", jc.machine_id).maybeSingle(),
    supabase.from("job_card_lines").select("kind, description, part_no, qty, unit_cost_cents, hours, rate_cents, total_cents").eq("job_card_id", id).is("deleted_at", null),
    supabase.from("farms").select("name").eq("id", jc.farm_id).maybeSingle(),
  ]);
  const machine = mData as { name: string; make: string | null; model: string | null; reg_no: string | null; meter_type: string } | null;
  const lines = (lData as Line[] | null) ?? [];
  const farmName = (farmData as { name: string } | null)?.name ?? "";

  const pdf = await Pdf.create(`Job card — ${machine?.name ?? "Machine"}`);
  pdf.header(`${farmName} · Job card ${jc.id.slice(0, 8)}${jc.locked ? " · APPROVED & LOCKED" : ""}`);

  pdf.kv("Machine", `${machine?.name ?? "—"}${machine?.make ? ` (${machine.make} ${machine.model ?? ""})` : ""}`);
  if (machine?.reg_no) pdf.kv("Registration", machine.reg_no);
  pdf.kv("Type / status", `${jc.type.replace(/_/g, " ")} · ${jc.status.replace(/_/g, " ")}`);
  pdf.kv("Date in / out", `${dash(jc.date_in)}  →  ${dash(jc.date_out)}`);
  pdf.kv("Meter reading", jc.meter_reading != null ? `${jc.meter_reading} ${machine?.meter_type ?? ""}` : "—");
  if (jc.approved_at) pdf.kv("Approved", jc.approved_at.slice(0, 10));

  pdf.heading("Problem & work");
  pdf.text(`Reported: ${dash(jc.reported_problem)}`, { gap: 2 });
  pdf.text(`Diagnosis: ${dash(jc.diagnosis)}`, { gap: 2 });
  pdf.text(`Work performed: ${dash(jc.work_performed)}`, { gap: 4 });

  pdf.heading("Lines");
  if (lines.length === 0) {
    pdf.text("No lines.", { color: undefined });
  } else {
    pdf.table(
      ["Description", "Detail", "Line total"],
      lines.map((l) => [
        l.description ?? l.kind,
        l.kind === "part" ? `${l.qty ?? 0} × ${rands(l.unit_cost_cents)}` : l.kind === "labour" ? `${l.hours ?? 0}h × ${rands(l.rate_cents)}` : rands(l.unit_cost_cents),
        rands(l.total_cents),
      ]),
      [270, 130, 99],
      [false, false, true],
    );
  }

  pdf.gap(6);
  pdf.hr();
  pdf.kv("Parts (ex-VAT)", rands(jc.parts_total_cents));
  pdf.kv("Labour (ex-VAT)", rands(jc.labour_total_cents));
  pdf.kv("Other (ex-VAT)", rands(jc.other_total_cents));
  pdf.kv("TOTAL (ex-VAT)", rands(jc.total_cents));

  if (jc.recommendations) {
    pdf.heading("Recommendations");
    pdf.text(jc.recommendations);
  }

  const bytes = await pdf.save();
  return pdfResponse(bytes, `jobcard-${jc.id.slice(0, 8)}.pdf`);
}
